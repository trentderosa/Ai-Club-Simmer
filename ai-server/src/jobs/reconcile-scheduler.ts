/**
 * Periodic XP reconcile inside the AI server process. Runs the same job as
 * `npm run reconcile:xp` (reconcileXpAwards) every XP_RECONCILE_INTERVAL_MS, so
 * failed awards are retried without anyone running the CLI. First run is one
 * interval after start, never at boot. Runs never overlap, every error is
 * caught and logged, and the timer is unref'd so it never keeps the process
 * alive. The database still applies every XP rule; UNIQUE(check_in_id) makes a
 * double award impossible.
 */
import { loadReconcileConfig, loadXpReconcileIntervalMs, type ReconcileConfig } from '../config.js';
import { SupabaseGeneratedXpAwarder } from '../services/generated-xp-awarder.js';
import { SupabaseXpAwarder, type XpAwarder } from '../services/xp-awarder.js';
import {
  reconcileXpAwards,
  type ReconcileCandidateSource,
  type ReconcileLogger,
} from './reconcile-xp-core.js';
import { SupabaseReconcileSource } from './supabase-reconcile-source.js';

export interface ReconcileSchedulerDeps {
  /** True when ALLOW_STUB_AUTH is in effect (dev). The scheduler stays off. */
  stubAuth: boolean;
  createSource?: (config: ReconcileConfig) => ReconcileCandidateSource;
  createAwarder?: (config: ReconcileConfig) => XpAwarder;
  createGeneratedAwarder?: (config: ReconcileConfig) => XpAwarder;
  logger?: ReconcileLogger;
}

export type ReconcileScheduler =
  | { enabled: true; intervalMs: number; stop: () => void }
  | { enabled: false; reason: string };

const consoleLogger: ReconcileLogger = {
  info: (message, context) => console.info(message, JSON.stringify(context)),
  error: (message, context) => console.error(message, JSON.stringify(context)),
};

/** Drops the summary line for idle runs so the log isn't noisy every interval. */
function quietWhenIdle(base: ReconcileLogger): ReconcileLogger {
  return {
    error: (message, context): void => base.error(message, context),
    info: (message, context): void => {
      if (message === 'xp_reconcile_summary' && !context.scanned && !context.failed) return;
      base.info(message, context);
    },
  };
}

/**
 * Throws only for a bad XP_RECONCILE_INTERVAL_MS (or other reconcile bound),
 * so startup fails fast like other config errors. Returns a disabled result
 * with a reason (variable names only) when it should not run.
 */
export function startReconcileScheduler(
  env: Record<string, string | undefined>,
  deps: ReconcileSchedulerDeps
): ReconcileScheduler {
  const intervalMs = loadXpReconcileIntervalMs(env);
  if (intervalMs === 0) return { enabled: false, reason: 'XP_RECONCILE_INTERVAL_MS=0' };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { enabled: false, reason: 'no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY' };
  }
  if (deps.stubAuth) return { enabled: false, reason: 'stub auth is on' };

  const config = loadReconcileConfig(env);
  const logger = quietWhenIdle(deps.logger ?? consoleLogger);
  const creds = { url: config.url, serviceRoleKey: config.serviceRoleKey, timeoutMs: config.timeoutMs };
  const source = deps.createSource?.(config) ?? new SupabaseReconcileSource(creds);
  const awarder = deps.createAwarder?.(config) ?? new SupabaseXpAwarder(creds);
  const generatedAwarder =
    deps.createGeneratedAwarder?.(config) ?? new SupabaseGeneratedXpAwarder(creds);

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      logger.info('xp_reconcile_skipped_overlap', {});
      return;
    }
    running = true;
    try {
      await reconcileXpAwards(
        source,
        awarder,
        {
          lookbackHours: config.lookbackHours,
          minAgeSeconds: config.minAgeSeconds,
          batchLimit: config.batchLimit,
        },
        logger,
        generatedAwarder
      );
    } catch (error) {
      try {
        logger.error('xp_reconcile_scan_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Logging must never break the schedule.
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  return { enabled: true, intervalMs, stop: () => clearInterval(timer) };
}
