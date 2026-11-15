import {
  CHECK_IN_TIMEOUT_MS,
  LANDED_WITHOUT_RESPONSE_NOTE,
  RECIPE_TIMEOUT_MS,
  SERVER_OLLAMA_ATTEMPTS,
  SERVER_OLLAMA_TIMEOUT_MS,
  SERVER_VIDEO_LOOKUP_BUDGET_MS,
  didCheckInLand,
  inferXpFromSummaries,
  newIdempotencyKey,
  responseForLandedCheckIn,
} from './check-in-retry';
import type { PlanSummary } from '../api/schemas';

const summary = (total_xp: number): PlanSummary => ({
  total_xp,
  completed_slots: 3,
  total_slots: 10,
  current_slot_order: 4,
  path_complete: false,
  days_per_week: 3,
  minutes_per_session: 30,
  suggested_sessions_per_week: 2,
  estimated_weeks_remaining: 4,
});

describe('check-in retry helpers', () => {
  it('covers the server worst-case Ollama budget', () => {
    const ollamaBudget = SERVER_OLLAMA_ATTEMPTS * SERVER_OLLAMA_TIMEOUT_MS;
    expect(RECIPE_TIMEOUT_MS).toBeGreaterThanOrEqual(ollamaBudget + SERVER_VIDEO_LOOKUP_BUDGET_MS);
    expect(CHECK_IN_TIMEOUT_MS).toBeGreaterThanOrEqual(ollamaBudget);
    expect(CHECK_IN_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(RECIPE_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  it('mints unique UUIDs', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });

  it('detects a landed check-in from times_completed', () => {
    expect(didCheckInLand(0, { times_completed: 1 })).toBe(true);
    expect(didCheckInLand(1, { times_completed: 2 })).toBe(true);
    expect(didCheckInLand(0, { times_completed: 0 })).toBe(false);
    expect(didCheckInLand(1, { times_completed: 1 })).toBe(false);
    expect(didCheckInLand(0, undefined)).toBe(false);
  });

  it('infers awarded XP from a positive summary delta and pending otherwise', () => {
    expect(inferXpFromSummaries(summary(239), summary(382), 0)).toEqual({
      status: 'awarded',
      xp_awarded: 143,
      is_first_completion: true,
      capped: false,
    });
    expect(inferXpFromSummaries(summary(239), summary(311), 1)).toEqual({
      status: 'awarded',
      xp_awarded: 72,
      is_first_completion: false,
      capped: false,
    });
    expect(inferXpFromSummaries(summary(239), summary(239), 0)).toEqual({ status: 'failed' });
    expect(inferXpFromSummaries(summary(239), null, 0)).toEqual({ status: 'failed' });
    expect(inferXpFromSummaries(null, summary(382), 0)).toEqual({ status: 'failed' });
  });

  it('builds a complete-screen response without inventing badges or a coach note', () => {
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = responseForLandedCheckIn({
      idempotencyKey: key,
      rating: 'hard',
      summaryBefore: summary(239),
      summaryAfter: summary(382),
      timesCompletedBefore: 0,
    });
    expect(response.check_in_id).toBe(key);
    expect(response.coach_note).toBe(LANDED_WITHOUT_RESPONSE_NOTE);
    expect(response.xp).toMatchObject({ status: 'awarded', xp_awarded: 143 });
    expect(response.badges).toEqual({ status: 'failed' });
    expect(response.suggest_repeat).toBe(true);
    expect(responseForLandedCheckIn({
      idempotencyKey: key,
      rating: 'ok',
      summaryBefore: null,
      summaryAfter: null,
      timesCompletedBefore: 0,
    }).suggest_repeat).toBe(false);
  });
});
