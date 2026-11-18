import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startReconcileScheduler, type ReconcileScheduler } from './reconcile-scheduler.js';
import { loadXpReconcileIntervalMs } from '../config.js';
import type { ReconcileCandidateSource, ReconcileLogger } from './reconcile-xp-core.js';
import type { XpAwarder } from '../services/xp-awarder.js';

const ENV = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
};
const INTERVAL = 60000;

function logger(): ReconcileLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

const awarder: XpAwarder = {
  award: vi.fn().mockResolvedValue({ xp_awarded: 10, is_first_completion: true, capped: false }),
} as unknown as XpAwarder;

let started: ReconcileScheduler | null = null;

function start(
  source: ReconcileCandidateSource,
  log: ReconcileLogger,
  env: Record<string, string | undefined> = { ...ENV, XP_RECONCILE_INTERVAL_MS: String(INTERVAL) },
  stubAuth = false
): ReconcileScheduler {
  started = startReconcileScheduler(env, {
    stubAuth,
    createSource: () => source,
    createAwarder: () => awarder,
    createGeneratedAwarder: () => awarder,
    logger: log,
  });
  return started;
}

function emptySource(): ReconcileCandidateSource & { findCheckInsMissingXp: ReturnType<typeof vi.fn> } {
  return { findCheckInsMissingXp: vi.fn().mockResolvedValue([]) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (started?.enabled) started.stop();
  started = null;
  vi.useRealTimers();
});

describe('startReconcileScheduler', () => {
  it('stays off when the interval is 0', () => {
    const result = start(emptySource(), logger(), { ...ENV, XP_RECONCILE_INTERVAL_MS: '0' });
    expect(result).toEqual({ enabled: false, reason: 'XP_RECONCILE_INTERVAL_MS=0' });
  });

  it('stays off without Supabase config, naming variables only', () => {
    const result = start(emptySource(), logger(), {});
    expect(result.enabled).toBe(false);
    expect(JSON.stringify(result)).toContain('SUPABASE_URL');
  });

  it('stays off with stub auth', () => {
    const source = emptySource();
    const result = start(source, logger(), undefined, true);
    expect(result).toEqual({ enabled: false, reason: 'stub auth is on' });
  });

  it('runs first after one interval, not at boot, then repeatedly', async () => {
    const source = emptySource();
    const result = start(source, logger());
    expect(result.enabled && result.intervalMs).toBe(INTERVAL);
    expect(source.findCheckInsMissingXp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(source.findCheckInsMissingXp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledTimes(3);
  });

  it('defaults to 10 minutes', () => {
    const result = start(emptySource(), logger(), ENV);
    expect(result.enabled && result.intervalMs).toBe(600000);
  });

  it('skips a tick while a run is still going', async () => {
    let release: (value: never[]) => void = () => undefined;
    const source: ReconcileCandidateSource & { findCheckInsMissingXp: ReturnType<typeof vi.fn> } = {
      findCheckInsMissingXp: vi.fn().mockImplementation(
        () => new Promise<never[]>((resolve) => { release = resolve; })
      ),
    };
    const log = logger();
    start(source, log);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('xp_reconcile_skipped_overlap', {});
    release([]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledTimes(2);
  });

  it('logs a scan error and still runs the next tick', async () => {
    const source = emptySource();
    source.findCheckInsMissingXp.mockRejectedValueOnce(new Error('scan boom'));
    const log = logger();
    start(source, log);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(log.error).toHaveBeenCalledWith('xp_reconcile_scan_failed', { error: 'scan boom' });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.findCheckInsMissingXp).toHaveBeenCalledTimes(2);
  });

  it('logs a summary only when something was scanned or failed', async () => {
    const source = emptySource();
    const log = logger();
    start(source, log);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(log.info).not.toHaveBeenCalledWith('xp_reconcile_summary', expect.anything());

    source.findCheckInsMissingXp.mockResolvedValueOnce([
      { check_in_id: 'c1', slot_id: 1, created_at: '2026-11-12T20:00:00Z' },
    ]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(log.info).toHaveBeenCalledWith(
      'xp_reconcile_summary',
      expect.objectContaining({ scanned: 1, awarded: 1 })
    );
  });

  it('unrefs the interval timer', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    start(emptySource(), logger());
    const handle = spy.mock.results[0]?.value as { hasRef: () => boolean };
    expect(handle.hasRef()).toBe(false);
    spy.mockRestore();
  });

  it('throws on a bad batch limit when the schedule is on', () => {
    expect(() =>
      start(emptySource(), logger(), { ...ENV, XP_RECONCILE_BATCH_LIMIT: '5000' })
    ).toThrow(/XP_RECONCILE_BATCH_LIMIT/);
  });

  it('throws on a bad interval even without Supabase config', () => {
    expect(() => start(emptySource(), logger(), { XP_RECONCILE_INTERVAL_MS: '59999' })).toThrow(
      /XP_RECONCILE_INTERVAL_MS/
    );
  });

  it('stop() ends future runs', async () => {
    const source = emptySource();
    const result = start(source, logger());
    if (result.enabled) result.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(source.findCheckInsMissingXp).not.toHaveBeenCalled();
  });
});

describe('loadXpReconcileIntervalMs', () => {
  it('defaults to 600000', () => {
    expect(loadXpReconcileIntervalMs({})).toBe(600000);
  });
  it('accepts 0, the minimum and the maximum', () => {
    expect(loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '0' })).toBe(0);
    expect(loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '60000' })).toBe(60000);
    expect(loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '86400000' })).toBe(86400000);
  });
  it('rejects values out of range', () => {
    expect(() => loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '59999' })).toThrow(
      /XP_RECONCILE_INTERVAL_MS/
    );
    expect(() => loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '86400001' })).toThrow();
    expect(() => loadXpReconcileIntervalMs({ XP_RECONCILE_INTERVAL_MS: '-1' })).toThrow();
  });
});
