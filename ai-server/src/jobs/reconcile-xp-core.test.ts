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
      reason: 'timeout',
      error: 'award_slot_xp timed out after 5000ms',
    });
    expect(logger.error).toHaveBeenNthCalledWith(2, 'xp_reconcile_award_failed', {
      check_in_id: rows[1].check_in_id,
      slot_id: 1,
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
      created_at: rows[0].created_at,
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
