/**
 * Reconcile missing XP awards (F7).
 *
 * Every saved check-in should have exactly one xp_events row, written by
 * award_slot_xp. When the live award after a check-in fails (timeout, network,
 * 5xx), the check-in is kept without one. This job finds those check-ins in a
 * bounded window and re-runs award_slot_xp for each, oldest first.
 *
 * Safe to run repeatedly or concurrently: award_slot_xp locks the check-in row
 * and the user (advisory lock), and UNIQUE(check_in_id) on xp_events makes a
 * second award for the same check-in fail with a unique violation, which the
 * awarder reports as reason "already_awarded" and this job counts as done, not
 * as a failure. XP amounts, the 50% repeat rule and the weekly cap stay in the
 * database function; nothing here computes XP.
 *
 * Kept free of runtime dependencies so the database tests (tests/) can drive it
 * against real Postgres.
 */
import { xpAwardErrorReason, type XpAwarder } from '../services/xp-awarder.js';

export interface ReconcileCandidate {
  check_in_id: string;
  slot_id: number;
  created_at: string;
}

export interface ReconcileWindow {
  /** Inclusive lower bound on check_ins.created_at. */
  from: Date;
  /** Inclusive upper bound on check_ins.created_at (now minus the minimum age). */
  to: Date;
  /** Maximum number of check-ins to scan in one run. */
  limit: number;
}

/** Finds check-ins in the window that have no xp_events row, oldest first. */
export interface ReconcileCandidateSource {
  findCheckInsMissingXp(window: ReconcileWindow): Promise<ReconcileCandidate[]>;
}

export interface ReconcileLogger {
  info(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export interface ReconcileOptions {
  lookbackHours: number;
  minAgeSeconds: number;
  batchLimit: number;
  dryRun?: boolean;
  now?: Date;
}

export interface ReconcileSummary {
  scanned: number;
  awarded: number;
  /** Already had an award by the time we tried (another run or a late live award). */
  skipped: number;
  failed: number;
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
  };
}

export async function reconcileXpAwards(
  source: ReconcileCandidateSource,
  awarder: XpAwarder,
  options: ReconcileOptions,
  logger: ReconcileLogger
): Promise<ReconcileSummary> {
  const window = reconcileWindow(options);
  const candidates = await source.findCheckInsMissingXp(window);
  const dryRun = options.dryRun ?? false;

  let awarded = 0;
  let skipped = 0;
  let failed = 0;

  // One at a time, oldest first, so first-vs-repeat follows check-in order
  // and we never hold more than one user's advisory lock.
  for (const candidate of candidates) {
    if (dryRun) {
      logger.info('xp_reconcile_candidate', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
        created_at: candidate.created_at,
      });
      continue;
    }
    try {
      const result = await awarder.award(candidate.check_in_id);
      awarded++;
      logger.info('xp_reconcile_awarded', {
        check_in_id: candidate.check_in_id,
        slot_id: candidate.slot_id,
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
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary: ReconcileSummary = {
    scanned: candidates.length,
    awarded,
    skipped,
    failed,
    dry_run: dryRun,
    batch_full: candidates.length >= window.limit,
    window_from: window.from.toISOString(),
    window_to: window.to.toISOString(),
  };
  logger.info('xp_reconcile_summary', { ...summary });
  return summary;
}
