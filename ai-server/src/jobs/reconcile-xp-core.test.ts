import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  reconcileWindow,
  reconcileXpAwards,
  type ReconcileCandidate,
  type ReconcileCandidateSource,
  type ReconcileLogger,
} from './reconcile-xp-core.js';
import { XpAwardError, type XpAwarder, type XpAwardResult } from '../services/xp-awarder.js';

const NOW = new Date('2026-11-12T22:00:00.000Z');
const OPTIONS = { lookbackHours: 168, minAgeSeconds: 120, batchLimit: 3, now: NOW };

function candidate(slot = 1): ReconcileCandidate {
  return { check_in_id: randomUUID(), slot_id: slot, created_at: '2026-11-12T20:00:00.000Z' };
}

function result(xp: number): XpAwardResult {
  return { xp_awarded: xp, is_first_completion: true, weekly_repeat_remaining: 100, capped: false };
}

function makeLogger(): ReconcileLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

function sourceOf(rows: ReconcileCandidate[]): ReconcileCandidateSource & {
  findCheckInsMissingXp: ReturnType<typeof vi.fn>;
} {
  return { findCheckInsMissingXp: vi.fn().mockResolvedValue(rows) };
}

describe('reconcileWindow', () => {
  it('spans [now - lookback, now - min age] with the batch limit', () => {
    expect(reconcileWindow(OPTIONS)).toEqual({
      from: new Date('2026-11-05T22:00:00.000Z'),
      to: new Date('2026-11-12T21:58:00.000Z'),
      limit: 3,
      maxAttempts: 15,
      retryBaseMinutes: 10,
    });
  });
});

describe('reconcileXpAwards', () => {
  it('awards each missing check-in once, oldest first, and logs a summary', async () => {
    const rows = [candidate(1), candidate(2)];
    const source = sourceOf(rows);
    const awarder: XpAwarder = {
      award: vi.fn().mockResolvedValueOnce(result(102)).mockResolvedValueOnce(result(62)),
    };
    const logger = makeLogger();

    const summary = await reconcileXpAwards(source, awarder, OPTIONS, logger);

    expect(source.findCheckInsMissingXp).toHaveBeenCalledWith(reconcileWindow(OPTIONS));
    expect(vi.mocked(awarder.award).mock.calls).toEqual([[rows[0].check_in_id], [rows[1].check_in_id]]);
    expect(summary).toEqual({
      scanned: 2,
      awarded: 2,
      skipped: 0,
      failed: 0,
      given_up: 0,
      dry_run: false,
      batch_full: false,
      window_from: '2026-11-05T22:00:00.000Z',
      window_to: '2026-11-12T21:58:00.000Z',
    });
    expect(logger.info).toHaveBeenLastCalledWith('xp_reconcile_summary', summary);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('counts already_awarded as skipped (success), never as a failure', async () => {
    const rows = [candidate(), candidate()];
    const awarder: XpAwarder = {
      award: vi
        .fn()
        .mockRejectedValueOnce(new XpAwardError('already_awarded', 'award_slot_xp failed: 409 ...', 409))
        .mockResolvedValueOnce(result(51)),
    };
    const logger = makeLogger();

    const summary = await reconcileXpAwards(sourceOf(rows), awarder, OPTIONS, logger);

    expect(summary).toMatchObject({ scanned: 2, awarded: 1, skipped: 1, failed: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps going after a failure and logs the reason without secrets', async () => {
    const rows = [candidate(), candidate(), candidate()];
    const awarder: XpAwarder = {
      award: vi
        .fn()
        .mockRejectedValueOnce(new XpAwardError('timeout', 'award_slot_xp timed out after 5000ms'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(result(75)),
    };
    const logger = makeLogger();

    const summary = await reconcileXpAwards(sourceOf(rows), awarder, OPTIONS, logger);

    expect(awarder.award).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ scanned: 3, awarded: 1, skipped: 0, failed: 2, batch_full: true });
    expect(logger.error).toHaveBeenNthCalledWith(1, 'xp_reconcile_award_failed', {
      check_in_id: rows[0].check_in_id,
      slot_id: 1,
      kind: 'slot',
      reason: 'timeout',
      error: 'award_slot_xp timed out after 5000ms',
    });
    expect(logger.error).toHaveBeenNthCalledWith(2, 'xp_reconcile_award_failed', {
      check_in_id: rows[1].check_in_id,
      slot_id: 1,
      kind: 'slot',
      reason: 'unknown',
      error: 'boom',
    });
  });

  it('dry run lists candidates and never calls the awarder', async () => {
    const rows = [candidate()];
    const awarder: XpAwarder = { award: vi.fn() };
    const logger = makeLogger();

    const summary = await reconcileXpAwards(sourceOf(rows), awarder, { ...OPTIONS, dryRun: true }, logger);

    expect(awarder.award).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, awarded: 0, skipped: 0, failed: 0, dry_run: true });
    expect(logger.info).toHaveBeenCalledWith('xp_reconcile_candidate', {
      check_in_id: rows[0].check_in_id,
      slot_id: 1,
      kind: 'slot',
      created_at: rows[0].created_at,
    });
  });

  it('retries a cook-anything check-in with the generated awarder and leaves the slot awarder alone', async () => {
    const generated: ReconcileCandidate = {
      check_in_id: randomUUID(),
      slot_id: null,
      created_at: '2026-11-12T18:00:00.000Z',
      kind: 'generated',
    };
    const slot = candidate(3);
    const awarder: XpAwarder = { award: vi.fn().mockResolvedValue(result(62)) };
    const generatedAwarder: XpAwarder = { award: vi.fn().mockResolvedValue(result(84)) };
    const logger = makeLogger();

    const summary = await reconcileXpAwards(
      sourceOf([generated, slot]),
      awarder,
      OPTIONS,
      logger,
      generatedAwarder
    );

    expect(vi.mocked(generatedAwarder.award).mock.calls).toEqual([[generated.check_in_id]]);
    expect(vi.mocked(awarder.award).mock.calls).toEqual([[slot.check_in_id]]);
    expect(summary).toMatchObject({ scanned: 2, awarded: 2, skipped: 0, failed: 0 });
    expect(logger.info).toHaveBeenCalledWith('xp_reconcile_awarded', {
      check_in_id: generated.check_in_id,
      slot_id: null,
      kind: 'generated',
      xp_awarded: 84,
      is_first_completion: true,
      capped: false,
    });
  });

  it('counts already_awarded on a cook-anything check-in as skipped', async () => {
    const generated: ReconcileCandidate = {
      check_in_id: randomUUID(),
      slot_id: null,
      created_at: '2026-11-12T18:00:00.000Z',
      kind: 'generated',
    };
    const generatedAwarder: XpAwarder = {
      award: vi.fn().mockRejectedValue(new XpAwardError('already_awarded', 'award_generated_recipe_xp failed: 409', 409)),
    };

    const summary = await reconcileXpAwards(
      sourceOf([generated]),
      { award: vi.fn() },
      OPTIONS,
      makeLogger(),
      generatedAwarder
    );

    expect(summary).toMatchObject({ scanned: 1, awarded: 0, skipped: 1, failed: 0 });
  });

  it('fails a cook-anything candidate when no generated awarder is configured', async () => {
    const generated: ReconcileCandidate = {
      check_in_id: randomUUID(),
      slot_id: null,
      created_at: '2026-11-12T18:00:00.000Z',
      kind: 'generated',
    };
    const logger = makeLogger();
    const summary = await reconcileXpAwards(sourceOf([generated]), { award: vi.fn() }, OPTIONS, logger);

    expect(summary).toMatchObject({ scanned: 1, awarded: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith('xp_reconcile_award_failed', {
      check_in_id: generated.check_in_id,
      slot_id: null,
      kind: 'generated',
      reason: 'unknown',
      error: 'Cook-anything reconcile awarder is not configured',
    });
  });

  it('does nothing when there are no candidates', async () => {
    const awarder: XpAwarder = { award: vi.fn() };
    const summary = await reconcileXpAwards(sourceOf([]), awarder, OPTIONS, makeLogger());
    expect(awarder.award).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 0, awarded: 0, skipped: 0, failed: 0, batch_full: false });
  });

  it('propagates a scan error (nothing awarded)', async () => {
    const source: ReconcileCandidateSource = {
      findCheckInsMissingXp: vi.fn().mockRejectedValue(new Error('Database error')),
    };
    const awarder: XpAwarder = { award: vi.fn() };
    await expect(reconcileXpAwards(source, awarder, OPTIONS, makeLogger())).rejects.toThrow('Database error');
    expect(awarder.award).not.toHaveBeenCalled();
  });
});

describe('reconcileXpAwards attempt tracking', () => {
  function trackingSource(
    rows: ReconcileCandidate[],
    givenUp = 0
  ): ReconcileCandidateSource & {
    findCheckInsMissingXp: ReturnType<typeof vi.fn>;
    recordFailedAttempt: ReturnType<typeof vi.fn>;
    countGivenUp: ReturnType<typeof vi.fn>;
    listGivenUp: ReturnType<typeof vi.fn>;
  } {
    return {
      findCheckInsMissingXp: vi.fn().mockResolvedValue(rows),
      recordFailedAttempt: vi.fn().mockResolvedValue(undefined),
      countGivenUp: vi.fn().mockResolvedValue(givenUp),
      listGivenUp: vi.fn().mockResolvedValue(['id-1', 'id-2']),
    };
  }

  it('records a failed award with a short reason code, not the error message', async () => {
    const row = candidate(1);
    const source = trackingSource([row]);
    const awarder: XpAwarder = {
      award: vi.fn().mockRejectedValue(new XpAwardError('timeout', 'award_slot_xp timed out after 5000ms')),
    };
    const summary = await reconcileXpAwards(source, awarder, OPTIONS, makeLogger());
    expect(summary.failed).toBe(1);
    expect(source.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect(source.recordFailedAttempt).toHaveBeenCalledWith(row, 'timeout');
  });

  it('records unknown errors as "unknown" and a missing awarder as "not_configured"', async () => {
    const slot = candidate(1);
    const generated: ReconcileCandidate = {
      ...candidate(),
      slot_id: null,
      kind: 'generated',
      created_at: '2026-11-12T21:00:00.000Z',
    };
    const source = trackingSource([slot, generated]);
    const awarder: XpAwarder = { award: vi.fn().mockRejectedValue(new Error('boom')) };
    await reconcileXpAwards(source, awarder, OPTIONS, makeLogger());
    expect(source.recordFailedAttempt.mock.calls).toEqual([
      [slot, 'unknown'],
      [generated, 'not_configured'],
    ]);
  });

  it('does not record successes, already_awarded, or dry runs', async () => {
    const [a, b, c] = [candidate(1), candidate(2), candidate(3)];
    const source = trackingSource([a, b]);
    const awarder: XpAwarder = {
      award: vi
        .fn()
        .mockResolvedValueOnce(result(10))
        .mockRejectedValueOnce(new XpAwardError('already_awarded', 'dup', 409)),
    };
    await reconcileXpAwards(source, awarder, OPTIONS, makeLogger());
    const dry = trackingSource([c]);
    await reconcileXpAwards(dry, { award: vi.fn() }, { ...OPTIONS, dryRun: true }, makeLogger());
    expect(source.recordFailedAttempt).not.toHaveBeenCalled();
    expect(dry.recordFailedAttempt).not.toHaveBeenCalled();
  });

  it('keeps going and logs when recording an attempt fails', async () => {
    const rows = [candidate(1), candidate(2)];
    const source = trackingSource(rows);
    source.recordFailedAttempt.mockRejectedValue(new Error('db down'));
    const awarder: XpAwarder = { award: vi.fn().mockRejectedValue(new XpAwardError('http', 'bad', 500)) };
    const logger = makeLogger();
    const summary = await reconcileXpAwards(source, awarder, OPTIONS, logger);
    expect(summary.failed).toBe(2);
    expect(awarder.award).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('xp_reconcile_attempt_record_failed', {
      check_in_id: rows[0].check_in_id,
      error: 'db down',
    });
  });

  it('passes maxAttempts to the source window and logs the given-up count only', async () => {
    const source = trackingSource([], 4);
    const logger = makeLogger();
    const summary = await reconcileXpAwards(source, { award: vi.fn() }, { ...OPTIONS, maxAttempts: 2 }, logger);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 2 }));
    expect(summary.given_up).toBe(4);
    expect(logger.info).toHaveBeenCalledWith('xp_reconcile_given_up', {
      given_up: 4,
      check_in_ids: ['id-1', 'id-2'],
    });
    expect(source.listGivenUp).toHaveBeenCalledWith(expect.anything(), 20);
  });

  it('tolerates a failing given-up count', async () => {
    const source = trackingSource([]);
    source.countGivenUp.mockRejectedValue(new Error('nope'));
    const logger = makeLogger();
    const summary = await reconcileXpAwards(source, { award: vi.fn() }, OPTIONS, logger);
    expect(summary.given_up).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('xp_reconcile_given_up_count_failed', { error: 'nope' });
  });

  it('processes the chosen batch oldest first even if the source returns retries first', async () => {
    const older = { ...candidate(1), created_at: '2026-11-10T00:00:00.000Z' };
    const newer = { ...candidate(1), created_at: '2026-11-12T00:00:00.000Z' };
    const awarder: XpAwarder = { award: vi.fn().mockResolvedValue(result(1)) };
    await reconcileXpAwards(sourceOf([newer, older]), awarder, OPTIONS, makeLogger());
    expect(vi.mocked(awarder.award).mock.calls).toEqual([[older.check_in_id], [newer.check_in_id]]);
  });

  it('caps the logged given-up ids at 20 and still logs the count when listing fails', async () => {
    const many = trackingSource([], 50);
    many.listGivenUp.mockResolvedValue(Array.from({ length: 30 }, (_, i) => `id-${i}`));
    const logger = makeLogger();
    await reconcileXpAwards(many, { award: vi.fn() }, OPTIONS, logger);
    const call = logger.info.mock.calls.find(([m]) => m === 'xp_reconcile_given_up');
    expect(call?.[1].given_up).toBe(50);
    expect(call?.[1].check_in_ids).toHaveLength(20);

    const broken = trackingSource([], 3);
    broken.listGivenUp.mockRejectedValue(new Error('nope'));
    const logger2 = makeLogger();
    await reconcileXpAwards(broken, { award: vi.fn() }, OPTIONS, logger2);
    expect(logger2.info).toHaveBeenCalledWith('xp_reconcile_given_up', { given_up: 3, check_in_ids: [] });
  });
});
