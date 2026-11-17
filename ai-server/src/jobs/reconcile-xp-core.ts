/**
 * Reconcile missing XP awards (F7 path slots and F11 Cook anything).
 *
 * Every saved check-in should have exactly one XP row: xp_events via
 * award_slot_xp, or generated_recipe_xp_events via award_generated_recipe_xp.
 * When the live award after a check-in fails (timeout, network, 5xx), the
 * check-in is kept without one. This job finds those check-ins in a bounded
 * window and re-runs the matching award for each, oldest first.
 *
 * Safe to run repeatedly or concurrently: both award functions lock the
 * check-in row and the user (advisory lock), and UNIQUE(check_in_id) on each
 * XP table makes a second award for the same check-in fail with a unique
 * violation, which the awarder reports as reason "already_awarded" and this
 * job counts as done, not as a failure. XP amounts, the 50% repeat rule, the
 * weekly cap and the free-form daily cap stay in the database functions;
 * nothing here computes XP.
 *
 * The source returns candidates already ordered oldest first. This loop does
 * not re-sort them.
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
}

/**
 * Finds check-ins in the window that have no XP row, oldest first.
 * Path rows have no xp_events row; Cook anything rows have no
 * generated_recipe_xp_events row. The batch limit applies to the merged list.
 */
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
  logger: ReconcileLogger,
  generatedAwarder: XpAwarder | null = null
): Promise<ReconcileSummary> {
  const window = reconcileWindow(options);
  const candidates = await source.findCheckInsMissingXp(window);
  const dryRun = options.dryRun ?? false;

  let awarded = 0;
  let skipped = 0;
  let failed = 0;

  // One at a time, in the source's oldest-first order, so first-vs-repeat
  // follows check-in order and we never hold more than one user's advisory lock.
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
