/**
 * CLI: re-run award_slot_xp for check-ins that have no XP award yet.
 *
 *   npm run build && npm run reconcile:xp              # award
 *   npm run reconcile:xp -- --dry-run                  # list only
 *   npm run reconcile:xp:dev -- --dry-run              # via tsx, no build
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role; server-side
 * only), plus optional XP_AWARD_TIMEOUT_MS, XP_RECONCILE_LOOKBACK_HOURS,
 * XP_RECONCILE_MIN_AGE_SECONDS and XP_RECONCILE_BATCH_LIMIT.
 *
 * Exit codes: 0 = no failures, 1 = at least one award failed or the scan
 * failed, 2 = bad config or arguments.
 */
import { pathToFileURL } from 'url';
import { loadReconcileConfig, type ReconcileConfig } from '../config.js';
import { SupabaseXpAwarder, type XpAwarder } from '../services/xp-awarder.js';
import {
  reconcileXpAwards,
  type ReconcileCandidateSource,
  type ReconcileLogger,
} from './reconcile-xp-core.js';
import { SupabaseReconcileSource } from './supabase-reconcile-source.js';

export interface ReconcileCliDeps {
  createSource?: (config: ReconcileConfig) => ReconcileCandidateSource;
  createAwarder?: (config: ReconcileConfig) => XpAwarder;
  logger?: ReconcileLogger;
  now?: Date;
}

const consoleLogger: ReconcileLogger = {
  info: (message, context) => console.info(message, JSON.stringify(context)),
  error: (message, context) => console.error(message, JSON.stringify(context)),
};

export async function runReconcileCli(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: ReconcileCliDeps = {}
): Promise<number> {
  const logger = deps.logger ?? consoleLogger;

  const unknownArgs = argv.filter((arg) => arg !== '--dry-run');
  if (unknownArgs.length > 0) {
    logger.error('xp_reconcile_config_error', {
      error: `Unknown argument(s): ${unknownArgs.join(' ')}. Usage: reconcile-xp [--dry-run]`,
    });
    return 2;
  }

  let config: ReconcileConfig;
  try {
    config = loadReconcileConfig(env);
  } catch (error) {
    logger.error('xp_reconcile_config_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 2;
  }

  const source =
    deps.createSource?.(config) ??
    new SupabaseReconcileSource({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      timeoutMs: config.timeoutMs,
    });
  const awarder =
    deps.createAwarder?.(config) ??
    new SupabaseXpAwarder({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      timeoutMs: config.timeoutMs,
    });

  try {
    const summary = await reconcileXpAwards(
      source,
      awarder,
      {
        lookbackHours: config.lookbackHours,
        minAgeSeconds: config.minAgeSeconds,
        batchLimit: config.batchLimit,
        dryRun: argv.includes('--dry-run'),
        now: deps.now,
      },
      logger
    );
    return summary.failed > 0 ? 1 : 0;
  } catch (error) {
    logger.error('xp_reconcile_scan_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runReconcileCli(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error('xp_reconcile_crashed', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
