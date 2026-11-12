import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';
// The real reconcile loop from the ai-server (dependency-free on purpose).
import {
  reconcileXpAwards,
  type ReconcileCandidateSource,
  type ReconcileLogger,
  type ReconcileOptions,
  type ReconcileSummary,
} from '../../ai-server/src/jobs/reconcile-xp-core.js';
import { XpAwardError, type XpAwarder } from '../../ai-server/src/services/xp-awarder.js';

/**
 * XP reconcile job at the database level.
 *
 * Drives the ai-server's reconcileXpAwards() against real Postgres:
 * - the candidate scan is the SQL twin of the PostgREST anti-join the job uses
 * - awards go through award_slot_xp as service_role (the production path)
 * - a unique violation on xp_events(check_in_id) maps to "already_awarded",
 *   exactly as PostgREST's 409/23505 does in SupabaseXpAwarder
 * Fake users and data only.
 */
describe('XP reconcile job (failed or missing awards)', () => {
  let db: TestDatabase;
  let user: TestUser;
  let slot1: number;
  let slot2: number;
  let slot1Xp: number;
  let slot2Xp: number;
  let recipe1: string;
  let recipe2: string;

  const silent: ReconcileLogger = { info: () => undefined, error: () => undefined };

  const source = (): ReconcileCandidateSource => ({
    findCheckInsMissingXp: (window) => db.findCheckInsMissingXp(window.from, window.to, window.limit),
  });

  const awarder = (): XpAwarder => ({
    async award(checkInId) {
      try {
        const row = await db.awardSlotXp(checkInId);
        return {
          xp_awarded: row.out_xp_awarded,
          is_first_completion: row.out_is_first_completion,
          weekly_repeat_remaining: row.out_weekly_repeat_remaining,
          capped: row.out_capped,
        };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new XpAwardError('already_awarded', 'award_slot_xp failed: 409 duplicate', 409);
        }
        throw e;
      }
    },
  });

  // now slightly in the future and min age 0 so rows created during the test are in the window.
  const options = (overrides: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
    lookbackHours: 168,
    minAgeSeconds: 0,
    batchLimit: 100,
    now: new Date(Date.now() + 60_000),
    ...overrides,
  });

  const reconcile = (overrides: Partial<ReconcileOptions> = {}): Promise<ReconcileSummary> =>
    reconcileXpAwards(source(), awarder(), options(overrides), silent);

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    await db.dropAllTables();
    await db.runAllMigrations();
    await db.setupRoles();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.cleanupTestData();
    await db.resetXpConfig();

    user = await db.createTestUser(`test-reconcile-${Date.now()}@example.com`);
    await db.createProfile(user.id);
    slot1 = await db.getSlotId(1);
    slot2 = await db.getSlotId(2);
    slot1Xp = await db.getSlotXpValue(slot1);
    slot2Xp = await db.getSlotXpValue(slot2);
    recipe1 = await db.createUserRecipe(user.id, slot1);
    recipe2 = await db.createUserRecipe(user.id, slot2);
  });

  it('awards a missing award exactly once; a second run awards nothing', async () => {
    // Live award "failed": the check-in exists with no xp_events row.
    const checkInId = await db.createCheckIn(user.id, recipe1, slot1);
    expect(await db.getXpEventCount(checkInId)).toBe(0);

    const first = await reconcile();
    expect(first).toMatchObject({ scanned: 1, awarded: 1, skipped: 0, failed: 0 });
    expect(await db.getXpEventCount(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp);
    expect(await db.getCheckInIsRepeat(checkInId)).toBe(false);

    const second = await reconcile();
    expect(second).toMatchObject({ scanned: 0, awarded: 0, skipped: 0, failed: 0 });
    expect(await db.getXpEventCount(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp);
  });

  it('skips check-ins that already have an award', async () => {
    const awardedLive = await db.createCheckIn(user.id, recipe1, slot1);
    await db.awardSlotXp(awardedLive);
    const missing = await db.createCheckIn(user.id, recipe2, slot2);

    const summary = await reconcile();

    expect(summary).toMatchObject({ scanned: 1, awarded: 1, failed: 0 });
    expect(await db.getXpEventCount(awardedLive)).toBe(1);
    expect(await db.getXpEventCount(missing)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp + slot2Xp);
  });

  it('treats a check-in awarded between scan and award as already awarded, not failed', async () => {
    const checkInId = await db.createCheckIn(user.id, recipe1, slot1);
    const racing: ReconcileCandidateSource = {
      async findCheckInsMissingXp(window) {
        const rows = await db.findCheckInsMissingXp(window.from, window.to, window.limit);
        await db.awardSlotXp(checkInId); // a late live award lands after the scan
        return rows;
      },
    };

    const summary = await reconcileXpAwards(racing, awarder(), options(), silent);

    expect(summary).toMatchObject({ scanned: 1, awarded: 0, skipped: 1, failed: 0 });
    expect(await db.getXpEventCount(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp);
  });

  it('repeats earn 50% and respect the 100 XP weekly repeat cap via the RPC', async () => {
    const firstCheckIn = await db.createCheckIn(user.id, recipe1, slot1);
    await db.awardSlotXp(firstCheckIn);
    const repeats: string[] = [];
    for (let i = 0; i < 4; i++) {
      repeats.push(await db.createCheckIn(user.id, recipe1, slot1));
    }

    const summary = await reconcile();

    const half = Math.floor((slot1Xp * 50) / 100);
    const cap = 100;
    const expected: number[] = [];
    let used = 0;
    for (let i = 0; i < repeats.length; i++) {
      const xp = Math.max(0, Math.min(half, cap - used));
      expected.push(xp);
      used += xp;
    }
    const details = await Promise.all(repeats.map((id) => db.getXpEventDetails(id)));

    expect(summary).toMatchObject({ scanned: 4, awarded: 4, failed: 0 });
    expect(details.map((d) => d?.xp_awarded)).toEqual(expected);
    expect(details.every((d) => d?.is_first_completion === false)).toBe(true);
    expect(used).toBe(cap);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp + cap);

    expect(await reconcile()).toMatchObject({ scanned: 0, awarded: 0 });
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp + cap);
  });

  it('concurrent runs never double-award', async () => {
    const ids = [
      await db.createCheckIn(user.id, recipe1, slot1),
      await db.createCheckIn(user.id, recipe2, slot2),
      await db.createCheckIn(user.id, recipe1, slot1),
    ];

    const [a, b] = await Promise.all([reconcile(), reconcile()]);

    expect(a.failed + b.failed).toBe(0);
    expect(a.awarded + b.awarded).toBe(3);
    expect(a.skipped + b.skipped).toBe(a.scanned + b.scanned - 3);
    for (const id of ids) {
      expect(await db.getXpEventCount(id)).toBe(1);
    }
    const repeatXp = Math.floor((slot1Xp * 50) / 100);
    expect(await db.getUserTotalXp(user.id)).toBe(slot1Xp + slot2Xp + repeatXp);
  });

  it('only scans inside the lookback window and honors the batch limit', async () => {
    const old = await db.createCheckIn(user.id, recipe1, slot1);
    await db.backdateCheckIn(old, 10);
    const recent1 = await db.createCheckIn(user.id, recipe2, slot2);
    const recent2 = await db.createCheckIn(user.id, recipe2, slot2);

    const limited = await reconcile({ batchLimit: 1 });
    expect(limited).toMatchObject({ scanned: 1, awarded: 1, batch_full: true });
    expect(await db.getXpEventCount(recent1)).toBe(1);
    expect(await db.getXpEventCount(recent2)).toBe(0);

    const rest = await reconcile();
    expect(rest).toMatchObject({ scanned: 1, awarded: 1, batch_full: false });
    expect(await db.getXpEventCount(recent2)).toBe(1);
    expect(await db.getXpEventCount(old)).toBe(0);
  });

  it('leaves out check-ins younger than the minimum age', async () => {
    const fresh = await db.createCheckIn(user.id, recipe1, slot1);
    const summary = await reconcile({ now: new Date(), minAgeSeconds: 3600 });
    expect(summary.scanned).toBe(0);
    expect(await db.getXpEventCount(fresh)).toBe(0);
  });

  it('dry run awards nothing', async () => {
    const checkInId = await db.createCheckIn(user.id, recipe1, slot1);
    const summary = await reconcile({ dryRun: true });
    expect(summary).toMatchObject({ scanned: 1, awarded: 0, dry_run: true });
    expect(await db.getXpEventCount(checkInId)).toBe(0);
  });
});
