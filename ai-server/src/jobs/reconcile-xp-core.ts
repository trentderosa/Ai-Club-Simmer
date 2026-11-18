/**
 * Reconcile missing XP awards (F7 path slots and F11 Cook anything).
 *
 * Every saved check-in should have exactly one XP row: xp_events via
 * award_slot_xp, or generated_recipe_xp_events via award_generated_recipe_xp.
 * When the live award after a check-in fails (timeout, network, 5xx), the
 * check-in is kept without one. This job finds those check-ins in a bounded
 * window and re-runs the matching award for each.
 *
 * Safe to run repeatedly or concurrently: both award functions lock the
 * check-in row and the user (advisory lock), and UNIQUE(check_in_id) on each
 * XP table makes a second award for the same check-in fail with a unique
 * violation, which the awarder reports as reason "already_awarded" and this
 * job counts as done, not as a failure. XP amounts, the 50% repeat rule, the
 * weekly cap and the free-form daily cap stay in the database functions;
 * nothing here computes XP.
 *
 * The source decides which check-ins make the batch: never attempted first,
 * then least recently attempted, then oldest, skipping check-ins that already
 * failed `maxAttempts` times, so a pile of failing check-ins cannot starve
 * newer ones. The chosen batch is then processed oldest first, so within a
 * batch first-vs-repeat follows check-in order. A failed check-in is retried
 * only after an exponential backoff gap, so a short outage can't burn its
 * attempts in minutes. Failed awards are recorded
 * through the source (attempt count, time, short reason code).
 *
 * Kept free of runtime dependencies so the database tests (tests/) can drive it
 * against real Postgres.
 */
import { xpAwardErrorReason, type XpAwarder } from '../services/xp-awarder.js';

export type ReconcileCandidateKind = 'slot' | 'generated';

export interface ReconcileCandidate {
  check_in_id: string;
  /** Path slot id. Null for a Cook anything check-in. */
  slot_id: number | null;
  created_at: string;
  /**
   * Which award to retry. Omitted means a path slot, so existing callers
   * that only return slot rows keep working.
   */
  kind?: ReconcileCandidateKind;
}

export function reconcileCandidateKind(candidate: ReconcileCandidate): ReconcileCandidateKind {
  return candidate.kind === 'generated' ? 'generated' : 'slot';
}

export interface ReconcileWindow {
  /** Inclusive lower bound on check_ins.created_at. */
  from: Date;
  /** Inclusive upper bound on check-in created_at (now minus the minimum age). */
  to: Date;
  /** Maximum number of check-ins to scan in one run. */
  limit: number;
  /** Check-ins with this many failed attempts or more are left out. */
  maxAttempts: number;
  /** Retry backoff base in minutes: n failures wait base * 2^(n-1), capped at 24 h. */
  retryBaseMinutes: number;
}

/** Defaults for XP_RECONCILE_MAX_ATTEMPTS / XP_RECONCILE_RETRY_BASE_MINUTES (config is the source of truth). */
export const DEFAULT_RECONCILE_MAX_ATTEMPTS = 15;
export const DEFAULT_RECONCILE_RETRY_BASE_MINUTES = 10;
/** Most given-up check-in ids logged per run. */
export const GIVEN_UP_LOG_LIMIT = 20;

/**
 * Finds check-ins in the window that have no XP row.
 * Path rows have no xp_events row; Cook anything rows have no
 * generated_recipe_xp_events row. The batch limit applies to the merged list.
 * Order: never attempted first, then oldest last attempt, then oldest check-in;
 * check-ins at or over window.maxAttempts are excluded.
 *
 * The two optional methods persist attempts. Sources that cannot (tests,
 * simple fakes) leave them out and the job just skips tracking.
 */
export interface ReconcileCandidateSource {
  findCheckInsMissingXp(window: ReconcileWindow): Promise<ReconcileCandidate[]>;
  /** Called after a failed award. `reason` is a short code, never an error message. */
  recordFailedAttempt?(candidate: ReconcileCandidate, reason: string): Promise<void>;
  /** How many in-window missing check-ins are over window.maxAttempts. */
  countGivenUp?(window: ReconcileWindow): Promise<number>;
  /** Ids (and nothing else) of up to `limit` given-up check-ins, oldest first. */
  listGivenUp?(window: ReconcileWindow, limit: number): Promise<string[]>;
}

export interface ReconcileLogger {
  info(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export interface ReconcileOptions {
  lookbackHours: number;
  minAgeSeconds: number;
  batchLimit: number;
  /** Failed attempts before a check-in is given up on. Defaults to 10. */
  maxAttempts?: number;
  /** Retry backoff base in minutes. Defaults to 10. */
  retryBaseMinutes?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface ReconcileSummary {
  scanned: number;
  awarded: number;
  /** Already had an award by the time we tried (another run or a late live award). */
  skipped: number;
  failed: number;
  /** In-window check-ins skipped because they already failed maxAttempts times. */
  given_up: number;
  dry_run: boolean;
  /** True when the batch was full, so another run may find more. */
  batch_full: boolean;
  window_from: string;
  window_to: string;
}

export function reconcileWindow(options: ReconcileOptions): ReconcileWindow {
  const now = options.now ?? new Date();
  return {
    from: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    to: new Date(now.getTime() - options.minAgeSeconds * 1000),
    limit: options.batchLimit,
    maxAttempts: options.maxAttempts ?? DEFAULT_RECONCILE_MAX_ATTEMPTS,
    retryBaseMinutes: options.retryBaseMinutes ?? DEFAULT_RECONCILE_RETRY_BASE_MINUTES,
  };
}

export async function reconcileXpAwards(
  source: ReconcileCandidateSource,
  awarder: XpAwarder,
  options: ReconcileOptions,
  logger: ReconcileLogger,
  generatedAwarder: XpAwarder | null = null
): Promise<ReconcileSummary> {
  const window = reconcileWindow(options);
  const found = await source.findCheckInsMissingXp(window);
  // Selection is by retry priority; processing is oldest first.
  // Stable, so equal timestamps keep the source's order.
  const candidates = [...found].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const dryRun = options.dryRun ?? false;

  let awarded = 0;
  let skipped = 0;
  let failed = 0;

  const recordAttempt = async (candidate: ReconcileCandidate, reason: string): Promise<void> => {
    if (!source.recordFailedAttempt) return;
    try {
      await source.recordFailedAttempt(candidate, reason);
    } catch (error) {
      logger.error('xp_reconcile_attempt_record_failed', {
        check_in_id: candidate.check_in_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // One at a time, oldest first, so first-vs-repeat follows check-in order
  // within the batch and we never hold more than one user's advisory lock.
  for (const candidate of candidates) {
    const kind = reconcileCandidateKind(candidate);
    if (dryRun) {
      logger.info('xp_reconcile_candidate', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
        kind,
        created_at: candidate.created_at,
      });
      continue;
    }
    const target = kind === 'generated' ? generatedAwarder : awarder;
    if (!target) {
      failed++;
      logger.error('xp_reconcile_award_failed', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
        kind,
        reason: 'unknown',
        error: 'Cook-anything reconcile awarder is not configured',
      });
      await recordAttempt(candidate, 'not_configured');
      continue;
    }
    try {
      const result = await target.award(candidate.check_in_id);
      awarded++;
      logger.info('xp_reconcile_awarded', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
        kind,
        xp_awarded: result.xp_awarded,
        is_first_completion: result.is_first_completion,
        capped: result.capped,
      });
    } catch (error) {
      const reason = xpAwardErrorReason(error);
      if (reason === 'already_awarded') {
        skipped++;
        continue;
      }
      failed++;
      logger.error('xp_reconcile_award_failed', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
        kind,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await recordAttempt(candidate, reason);
    }
  }

  let givenUp = 0;
  if (source.countGivenUp) {
    try {
      givenUp = await source.countGivenUp(window);
    } catch (error) {
      logger.error('xp_reconcile_given_up_count_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (givenUp > 0) {
      let ids: string[] = [];
      if (source.listGivenUp) {
        try {
          ids = (await source.listGivenUp(window, GIVEN_UP_LOG_LIMIT)).slice(0, GIVEN_UP_LOG_LIMIT);
        } catch (error) {
          logger.error('xp_reconcile_given_up_list_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Ids only, so someone can act on them (see ai-server/README.md).
      logger.info('xp_reconcile_given_up', { given_up: givenUp, check_in_ids: ids });
    }
  }

  const summary: ReconcileSummary = {
    scanned: candidates.length,
    awarded,
    skipped,
    failed,
    given_up: givenUp,
    dry_run: dryRun,
    batch_full: candidates.length >= window.limit,
    window_from: window.from.toISOString(),
    window_to: window.to.toISOString(),
  };
  logger.info('xp_reconcile_summary', { ...summary });
  return summary;
}
