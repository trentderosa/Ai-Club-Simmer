/**
 * Helpers for a check-in that may be retried after a timeout or drop.
 *
 * The server treats `idempotency_key` as check_ins.id, so posting the same
 * key twice cannot insert a second row or award XP twice. The screen still
 * avoids a blind re-POST after a network/timeout error: it re-reads the plan
 * and, if this slot's times_completed went up, treats the check-in as landed.
 */
import * as ExpoCrypto from 'expo-crypto';

import type { CheckInResponse, CheckInXp, PlanSlot, PlanSummary, Rating } from '../api/schemas';

/** Matches ai-server defaults: 3 Ollama attempts × OLLAMA_TIMEOUT_MS (60s). */
export const SERVER_OLLAMA_ATTEMPTS = 3;
export const SERVER_OLLAMA_TIMEOUT_MS = 60_000;
/** VIDEO_LOOKUP_BUDGET_MS after recipe generation. */
export const SERVER_VIDEO_LOOKUP_BUDGET_MS = 8_000;
/** validate + insert + award (5s default) + badge lookup, with slack. */
export const SERVER_CHECK_IN_PRE_NOTE_MS = 20_000;

/** Long enough to cover 3 generation attempts plus the video budget. */
export const RECIPE_TIMEOUT_MS =
  SERVER_OLLAMA_ATTEMPTS * SERVER_OLLAMA_TIMEOUT_MS + SERVER_VIDEO_LOOKUP_BUDGET_MS + 5_000;

/** Long enough to cover award/badges plus 3 coach-note attempts. */
export const CHECK_IN_TIMEOUT_MS =
  SERVER_OLLAMA_ATTEMPTS * SERVER_OLLAMA_TIMEOUT_MS + SERVER_CHECK_IN_PRE_NOTE_MS;

export const LANDED_WITHOUT_RESPONSE_NOTE =
  "Your check-in was saved. Your coach's note wasn't ready before the connection dropped.";

/** Shown on the check-in screen if the save is still running after this long. */
export const SLOW_CHECK_IN_HINT_MS = 15_000;
export const SLOW_CHECK_IN_HINT = 'Saving… your coach is writing a note';

/**
 * A UUID for one check-in attempt. Uses expo-crypto so it works on Hermes
 * (React Native has historically had no `crypto.randomUUID`) as well as web.
 */
export function newIdempotencyKey(): string {
  return ExpoCrypto.randomUUID();
}

/** True when the plan shows this slot completed one more time than before the submit. */
export function didCheckInLand(
  timesCompletedBefore: number,
  slotAfter: Pick<PlanSlot, 'times_completed'> | undefined,
): boolean {
  return slotAfter != null && slotAfter.times_completed > timesCompletedBefore;
}

/**
 * Best-effort XP from the summaries around a check-in we know landed but
 * whose 201 we never received. A positive delta is shown as awarded; otherwise
 * we report pending rather than invent a number (the award may still be in flight,
 * have failed, or have been capped at 0).
 */
export function inferXpFromSummaries(
  summaryBefore: PlanSummary | null,
  summaryAfter: PlanSummary | null,
  timesCompletedBefore: number,
): CheckInXp {
  if (!summaryBefore || !summaryAfter) return { status: 'failed' };
  const delta = summaryAfter.total_xp - summaryBefore.total_xp;
  if (delta > 0) {
    return {
      status: 'awarded',
      xp_awarded: delta,
      is_first_completion: timesCompletedBefore === 0,
      capped: false,
    };
  }
  return { status: 'failed' };
}

/** Build the complete-screen payload when the plan shows the check-in landed. */
export function responseForLandedCheckIn(opts: {
  idempotencyKey: string;
  rating: Rating;
  summaryBefore: PlanSummary | null;
  summaryAfter: PlanSummary | null;
  timesCompletedBefore: number;
}): CheckInResponse {
  return {
    check_in_id: opts.idempotencyKey,
    coach_note: LANDED_WITHOUT_RESPONSE_NOTE,
    xp: inferXpFromSummaries(opts.summaryBefore, opts.summaryAfter, opts.timesCompletedBefore),
    badges: { status: 'failed' },
    suggest_repeat: opts.rating === 'hard',
  };
}
