import { describe, it, expect, vi } from 'vitest';
import { runReconcileCli } from './reconcile-xp.js';
import type { ReconcileCandidateSource, ReconcileLogger } from './reconcile-xp-core.js';
import { XpAwardError, type XpAwarder } from '../services/xp-awarder.js';
import type { ReconcileConfig } from '../config.js';

const ENV = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
};

function logger(): ReconcileLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

const oneCandidate: ReconcileCandidateSource = {
  findCheckInsMissingXp: vi.fn().mockResolvedValue([
    { check_in_id: 'c1', slot_id: 1, created_at: '2026-11-12T20:00:00Z' },
  ]),
};

describe('runReconcileCli', () => {
  it('exits 2 and names missing variables only', async () => {
    const log = logger();
    const code = await runReconcileCli([], {}, { logger: log });
    expect(code).toBe(2);
    expect(log.error).toHaveBeenCalledWith('xp_reconcile_config_error', {
      error: 'Missing required config for XP reconcile: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
    });
  });

  it('exits 2 on an invalid bound without echoing the key', async () => {
    const log = logger();
    const code = await runReconcileCli([], { ...ENV, XP_RECONCILE_BATCH_LIMIT: '5000' }, { logger: log });
    expect(code).toBe(2);
    expect(JSON.stringify(log.error.mock.calls)).toContain('XP_RECONCILE_BATCH_LIMIT');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('exits 2 on unknown arguments', async () => {
    expect(await runReconcileCli(['--force'], ENV, { logger: logger() })).toBe(2);
  });

  it('passes env bounds through and exits 0 when everything is awarded or already awarded', async () => {
    let seen: ReconcileConfig | undefined;
    const awarder: XpAwarder = {
      award: vi.fn().mockRejectedValue(new XpAwardError('already_awarded', 'dup', 409)),
    };
    const code = await runReconcileCli(
      [],
      { ...ENV, XP_RECONCILE_LOOKBACK_HOURS: '24', XP_RECONCILE_MIN_AGE_SECONDS: '0', XP_RECONCILE_BATCH_LIMIT: '10', XP_AWARD_TIMEOUT_MS: '2000' },
      {
        logger: logger(),
        createSource: (config) => {
          seen = config;
          return oneCandidate;
        },
        createAwarder: () => awarder,
      }
    );
    expect(code).toBe(0);
    expect(seen).toMatchObject({ lookbackHours: 24, minAgeSeconds: 0, batchLimit: 10, timeoutMs: 2000 });
  });

  it('uses defaults: 168h lookback, 120s min age, 100 per batch, 5000ms timeout', async () => {
    let seen: ReconcileConfig | undefined;
    await runReconcileCli([], ENV, {
      logger: logger(),
      createSource: (config) => {
        seen = config;
        return { findCheckInsMissingXp: vi.fn().mockResolvedValue([]) };
      },
      createAwarder: () => ({ award: vi.fn() }),
    });
    expect(seen).toMatchObject({ lookbackHours: 168, minAgeSeconds: 120, batchLimit: 100, timeoutMs: 5000 });
  });

  it('exits 1 when an award fails', async () => {
    const code = await runReconcileCli([], ENV, {
      logger: logger(),
      createSource: () => oneCandidate,
      createAwarder: () => ({ award: vi.fn().mockRejectedValue(new XpAwardError('http', '500')) }),
    });
    expect(code).toBe(1);
  });

  it('exits 1 when the scan fails', async () => {
    const log = logger();
    const code = await runReconcileCli([], ENV, {
      logger: log,
      createSource: () => ({ findCheckInsMissingXp: vi.fn().mockRejectedValue(new Error('down')) }),
      createAwarder: () => ({ award: vi.fn() }),
    });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith('xp_reconcile_scan_failed', { error: 'down' });
  });

  it('--dry-run does not award', async () => {
    const award = vi.fn();
    const code = await runReconcileCli(['--dry-run'], ENV, {
      logger: logger(),
      createSource: () => oneCandidate,
      createAwarder: () => ({ award }),
    });
    expect(code).toBe(0);
    expect(award).not.toHaveBeenCalled();
  });
});
