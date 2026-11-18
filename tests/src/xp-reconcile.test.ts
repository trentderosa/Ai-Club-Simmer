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
 * - the candidate scan is the SQL twin of the two PostgREST anti-joins the job uses
 * - path awards go through award_slot_xp and Cook anything awards through
 *   award_generated_recipe_xp, both as service_role (the production path)
 * - a unique violation on either XP table's check_in_id maps to "already_awarded",
 *   exactly as PostgREST's 409/23505 does in the awarders
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

  // Same three calls the ai-server source makes: one RPC each, as service_role.
  const source = (): ReconcileCandidateSource => ({
    findCheckInsMissingXp: (window) =>
      db.findCheckInsMissingXp(window.from, window.to, window.limit, window.maxAttempts, window.retryBaseMinutes),
    recordFailedAttempt: (candidate, reason) =>
      db.recordXpAwardAttempt(
        candidate.check_in_id,
        candidate.kind === 'generated' ? 'generated' : 'path',
        reason
      ),
    countGivenUp: (window) => db.countXpReconcileGivenUp(window.from, window.to, window.maxAttempts),
    listGivenUp: (window, limit) => db.listXpReconcileGivenUp(window.from, window.to, window.maxAttempts, limit),
  });

  const awardFromRpc = async (
    run: (checkInId: string) => Promise<{
      out_xp_awarded: number;
      out_is_first_completion: boolean;
      out_weekly_repeat_remaining: number;
      out_capped: boolean;
    }>,
    checkInId: string,
    rpcName: string
  ) => {
    try {
      const row = await run(checkInId);
      return {
        xp_awarded: row.out_xp_awarded,
        is_first_completion: row.out_is_first_completion,
        weekly_repeat_remaining: row.out_weekly_repeat_remaining,
        capped: row.out_capped,
      };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new XpAwardError('already_awarded', `${rpcName} failed: 409 duplicate`, 409);
      }
      throw e;
    }
  };

  const awarder = (): XpAwarder => ({
    award: (checkInId) => awardFromRpc((id) => db.awardSlotXp(id), checkInId, 'award_slot_xp'),
  });

  const generatedAwarder = (): XpAwarder => ({
    award: (checkInId) =>
      awardFromRpc((id) => db.awardGeneratedRecipeXp(id), checkInId, 'award_generated_recipe_xp'),
  });

  // now slightly in the future and min age 0 so rows created during the test are in the window.
  const options = (overrides: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
    lookbackHours: 168,
    minAgeSeconds: 0,
    batchLimit: 100,
    retryBaseMinutes: 0, // backoff off; the backoff tests set it
    now: new Date(Date.now() + 60_000),
    ...overrides,
  });

  const reconcile = (overrides: Partial<ReconcileOptions> = {}): Promise<ReconcileSummary> =>
    reconcileXpAwards(source(), awarder(), options(overrides), silent, generatedAwarder());

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

    const summary = await reconcileXpAwards(racing, awarder(), options(), silent, generatedAwarder());

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

  it('awards a missing cook-anything award exactly once', async () => {
    const recipe = await db.createGeneratedRecipe(user.id, {
      stepCount: 5,
      ingredientCount: 6,
      timeEstimateMinutes: 20,
    });
    const checkInId = await db.createGeneratedCheckIn(user.id, recipe.id);
    expect(await db.countGeneratedXpEvents(checkInId)).toBe(0);

    const dry = await reconcile({ dryRun: true });
    expect(dry).toMatchObject({ scanned: 1, awarded: 0, dry_run: true });
    expect(await db.countGeneratedXpEvents(checkInId)).toBe(0);

    const first = await reconcile();
    expect(first).toMatchObject({ scanned: 1, awarded: 1, skipped: 0, failed: 0 });
    expect(await db.countGeneratedXpEvents(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(recipe.xp_value);

    const second = await reconcile();
    expect(second).toMatchObject({ scanned: 0, awarded: 0 });
    expect(await db.countGeneratedXpEvents(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(recipe.xp_value);
  });

  it('shares the batch with path check-ins, oldest first, and skips a late cook-anything award', async () => {
    const recipe = await db.createGeneratedRecipe(user.id, {
      dishQuery: 'Pad Thai',
      normalizedDishName: 'pad thai',
      stepCount: 5,
      ingredientCount: 6,
      timeEstimateMinutes: 20,
    });
    const older = await db.createGeneratedCheckIn(user.id, recipe.id);
    await db.backdateGeneratedCheckIn(older, 1);
    const outside = await db.createGeneratedCheckIn(user.id, recipe.id);
    await db.backdateGeneratedCheckIn(outside, 10);
    const newer = await db.createCheckIn(user.id, recipe1, slot1);

    const limited = await reconcile({ batchLimit: 1 });
    expect(limited).toMatchObject({ scanned: 1, awarded: 1, batch_full: true });
    expect(await db.countGeneratedXpEvents(older)).toBe(1);
    expect(await db.getXpEventCount(newer)).toBe(0);
    expect(await db.countGeneratedXpEvents(outside)).toBe(0);

    const pending = await db.createGeneratedCheckIn(user.id, recipe.id);
    await db.backdateGeneratedCheckIn(pending, 0);
    const racing: ReconcileCandidateSource = {
      async findCheckInsMissingXp(window) {
        const rows = await db.findCheckInsMissingXp(window.from, window.to, window.limit);
        await db.awardGeneratedRecipeXp(pending);
        return rows;
      },
    };
    const raced = await reconcileXpAwards(racing, awarder(), options(), silent, generatedAwarder());
    expect(raced.failed).toBe(0);
    expect(raced.skipped).toBe(1);
    expect(await db.countGeneratedXpEvents(pending)).toBe(1);
    expect(await db.getXpEventCount(newer)).toBe(1);
    expect(await db.countGeneratedXpEvents(outside)).toBe(0);

    const fresh = await db.createGeneratedCheckIn(user.id, recipe.id);
    const tooNew = await reconcile({ now: new Date(), minAgeSeconds: 3600 });
    expect(tooNew.scanned).toBe(0);
    expect(await db.countGeneratedXpEvents(fresh)).toBe(0);
    expect(await db.countGeneratedXpEvents(outside)).toBe(0);
  });

  describe('attempt tracking (xp_award_attempts)', () => {
    const failing: XpAwarder = {
      award: async () => {
        throw new XpAwardError('http', 'award_slot_xp failed: 500', 500);
      },
    };
    const reconcileFailing = (overrides: Partial<ReconcileOptions> = {}): Promise<ReconcileSummary> =>
      reconcileXpAwards(source(), failing, options(overrides), silent, failing);

    it('records an attempt per failed award (path and cook-anything) and increments it', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      const slotCheckIn = await db.createCheckIn(user.id, recipe1, slot1);
      const genCheckIn = await db.createGeneratedCheckIn(user.id, recipe.id);

      expect(await reconcileFailing()).toMatchObject({ scanned: 2, failed: 2, given_up: 0 });
      expect(await db.getXpAwardAttempt(slotCheckIn)).toMatchObject({
        kind: 'path',
        attempts: 1,
        last_reason: 'http',
      });
      expect(await db.getXpAwardAttempt(genCheckIn)).toMatchObject({ kind: 'generated', attempts: 1 });

      await reconcileFailing();
      expect((await db.getXpAwardAttempt(slotCheckIn))?.attempts).toBe(2);
      expect((await db.getXpAwardAttempt(genCheckIn))?.attempts).toBe(2);
    });

    it('does not record attempts for successes, already-awarded rows or dry runs', async () => {
      const ok = await db.createCheckIn(user.id, recipe1, slot1);
      await reconcileXpAwards(source(), awarder(), options({ dryRun: true }), silent, generatedAwarder());
      expect(await db.getXpAwardAttempt(ok)).toBeNull();
      await reconcile();
      expect(await db.getXpEventCount(ok)).toBe(1);
      expect(await db.getXpAwardAttempt(ok)).toBeNull();
    });

    it('stops retrying after maxAttempts and reports how many it gave up on', async () => {
      const stuck = await db.createCheckIn(user.id, recipe1, slot1);
      await reconcileFailing({ maxAttempts: 2 });
      await reconcileFailing({ maxAttempts: 2 });
      expect((await db.getXpAwardAttempt(stuck))?.attempts).toBe(2);

      const third = await reconcileFailing({ maxAttempts: 2 });
      expect(third).toMatchObject({ scanned: 0, failed: 0, given_up: 1 });
      expect((await db.getXpAwardAttempt(stuck))?.attempts).toBe(2);

      // A real awarder does not pick it up either; raising the limit does.
      const real = await reconcile({ maxAttempts: 2 });
      expect(real).toMatchObject({ scanned: 0, given_up: 1 });
      expect(await db.getXpEventCount(stuck)).toBe(0);
      const raised = await reconcile({ maxAttempts: 3 });
      expect(raised).toMatchObject({ scanned: 1, awarded: 1, given_up: 0 });
      expect(await db.getXpEventCount(stuck)).toBe(1);
    });

    it('orders never-attempted first, then least recently attempted, then oldest', async () => {
      const recent = await db.createCheckIn(user.id, recipe1, slot1);
      const stale = await db.createCheckIn(user.id, recipe2, slot2);
      const never = await db.createCheckIn(user.id, recipe2, slot2);
      await db.backdateCheckIn(recent, 3);
      await db.backdateCheckIn(stale, 2);
      await db.setXpAwardAttempt(recent, 'path', 1, 10);
      await db.setXpAwardAttempt(stale, 'path', 1, 60);

      const rows = await db.findCheckInsMissingXp(new Date(Date.now() - 86_400_000 * 30), new Date(Date.now() + 60_000), 10, 10, 0);
      expect(rows.map((r) => r.check_in_id)).toEqual([never, stale, recent]);
    });

    it('a new check-in is not starved behind a full batch of failing ones', async () => {
      const BATCH = 100;
      // 100 old check-ins that already failed once, all older than the new one.
      await db.getPool().query(
        `INSERT INTO check_ins (user_id, user_recipe_id, slot_id, difficulty_rating, created_at)
         SELECT $1, $2, $3, 'ok', NOW() - make_interval(hours => 2) - make_interval(secs => g)
           FROM generate_series(1, $4) g`,
        [user.id, recipe1, slot1, BATCH]
      );
      await db.getPool().query(
        `INSERT INTO xp_award_attempts (check_in_id, kind, attempts, last_attempt_at, last_reason)
         SELECT id, 'path', 1, NOW() - make_interval(mins => 5), 'http'
           FROM check_ins WHERE user_id = $1`,
        [user.id]
      );
      const newest = await db.createCheckIn(user.id, recipe2, slot2);

      const rows = await db.findCheckInsMissingXp(
        new Date(Date.now() - 86_400_000),
        new Date(Date.now() + 60_000),
        BATCH,
        10,
        0
      );
      expect(rows).toHaveLength(BATCH);
      expect(rows[0].check_in_id).toBe(newest);

      const summary = await reconcile({ batchLimit: BATCH });
      expect(summary).toMatchObject({ scanned: BATCH, batch_full: true });
      expect(await db.getXpEventCount(newest)).toBe(1);
    });

    it('backs off: a recently failed row is skipped until base * 2^(attempts-1) minutes pass', async () => {
      const id = await db.createCheckIn(user.id, recipe1, slot1);
      const from = new Date(Date.now() - 86_400_000);
      const to = new Date(Date.now() + 60_000);
      const ids = async (): Promise<string[]> =>
        (await db.findCheckInsMissingXp(from, to, 10, 100, 10)).map((r) => r.check_in_id);

      await db.setXpAwardAttempt(id, 'path', 1, 5); // 5 min ago, gap is 10
      expect(await ids()).toEqual([]);
      await db.setXpAwardAttempt(id, 'path', 1, 11);
      expect(await ids()).toEqual([id]);
      await db.setXpAwardAttempt(id, 'path', 3, 30); // gap 40
      expect(await ids()).toEqual([]);
      await db.setXpAwardAttempt(id, 'path', 3, 41);
      expect(await ids()).toEqual([id]);
      // capped at 24 h: attempts 20 would be huge uncapped
      await db.setXpAwardAttempt(id, 'path', 20, 60 * 23);
      expect(await ids()).toEqual([]);
      await db.setXpAwardAttempt(id, 'path', 20, 60 * 25);
      expect(await ids()).toEqual([id]);
    });

    it('backoff keeps never-attempted first and does not hide them behind waiting rows', async () => {
      const waiting = await db.createCheckIn(user.id, recipe1, slot1);
      const due = await db.createCheckIn(user.id, recipe2, slot2);
      const never = await db.createCheckIn(user.id, recipe2, slot2);
      await db.backdateCheckIn(waiting, 3);
      await db.backdateCheckIn(due, 2);
      await db.setXpAwardAttempt(waiting, 'path', 1, 2);
      await db.setXpAwardAttempt(due, 'path', 1, 30);
      const rows = await db.findCheckInsMissingXp(
        new Date(Date.now() - 86_400_000 * 30),
        new Date(Date.now() + 60_000),
        10,
        10,
        10
      );
      expect(rows.map((r) => r.check_in_id)).toEqual([never, due]);
    });

    it('lists given-up ids (ids only, limited) matching the count', async () => {
      const a = await db.createCheckIn(user.id, recipe1, slot1);
      const b = await db.createCheckIn(user.id, recipe2, slot2);
      await db.backdateCheckIn(a, 2);
      await db.setXpAwardAttempt(a, 'path', 3, 1);
      await db.setXpAwardAttempt(b, 'path', 3, 1);
      const from = new Date(Date.now() - 86_400_000 * 30);
      const to = new Date(Date.now() + 60_000);
      expect(await db.countXpReconcileGivenUp(from, to, 3)).toBe(2);
      expect(await db.listXpReconcileGivenUp(from, to, 3, 20)).toEqual([a, b]);
      expect(await db.listXpReconcileGivenUp(from, to, 3, 1)).toEqual([a]);
      expect(await db.countXpReconcileGivenUp(from, to, 4)).toBe(0);
    });

    it('sanitizes the reason to a short code', async () => {
      const id = await db.createCheckIn(user.id, recipe1, slot1);
      await db.recordXpAwardAttempt(id, 'path', 'Bad reason: secret=abc123 '.repeat(5));
      const row = await db.getXpAwardAttempt(id);
      expect(row?.last_reason).toMatch(/^[a-z_]{1,40}$/);
      await db.recordXpAwardAttempt(id, 'path', '123');
      expect((await db.getXpAwardAttempt(id))?.last_reason).toBe('unknown');
    });

    it('deletes the attempt row when its check-in is deleted (both kinds)', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      const slotCheckIn = await db.createCheckIn(user.id, recipe1, slot1);
      const genCheckIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      await db.recordXpAwardAttempt(slotCheckIn, 'path', 'http');
      await db.recordXpAwardAttempt(genCheckIn, 'generated', 'http');
      await db.getPool().query('DELETE FROM check_ins WHERE id = $1', [slotCheckIn]);
      await db.getPool().query('DELETE FROM generated_recipe_check_ins WHERE id = $1', [genCheckIn]);
      expect(await db.getXpAwardAttempt(slotCheckIn)).toBeNull();
      expect(await db.getXpAwardAttempt(genCheckIn)).toBeNull();
    });

    it('rejects an unknown kind', async () => {
      const id = await db.createCheckIn(user.id, recipe1, slot1);
      await expect(db.recordXpAwardAttempt(id, 'other' as 'path', 'http')).rejects.toThrow(/check constraint/i);
    });
  });

  describe('xp_award_attempts access control', () => {
    const fns = [
      'get_xp_reconcile_candidates(timestamptz, timestamptz, integer, integer, integer)',
      'list_xp_reconcile_given_up(timestamptz, timestamptz, integer, integer)',
      'count_xp_reconcile_given_up(timestamptz, timestamptz, integer)',
      'record_xp_award_attempt(uuid, text, text)',
    ];

    it('has RLS on and no client policies', async () => {
      const rls = await db
        .getPool()
        .query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xp_award_attempts'::regclass");
      expect(rls.rows[0].relrowsecurity).toBe(true);
      const policies = await db
        .getPool()
        .query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'xp_award_attempts'");
      expect(policies.rowCount).toBe(0);
    });

    it('denies anon and authenticated any table access, allows service_role', async () => {
      const id = await db.createCheckIn(user.id, recipe1, slot1);
      await db.recordXpAwardAttempt(id, 'path', 'http');
      for (const role of ['anon', 'authenticated']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const r = await db
            .getPool()
            .query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.xp_award_attempts', priv]);
          expect(r.rows[0].ok, `${role} ${priv}`).toBe(false);
        }
      }
      const svc = await db
        .getPool()
        .query("SELECT has_table_privilege('service_role', 'public.xp_award_attempts', 'SELECT') AS ok");
      expect(svc.rows[0].ok).toBe(true);
    });

    it('denies EXECUTE on the reconcile functions to anon and authenticated, allows service_role', async () => {
      for (const fn of fns) {
        expect(await db.hasFunctionPrivilege('anon', fn), `anon ${fn}`).toBe(false);
        expect(await db.hasFunctionPrivilege('authenticated', fn), `authenticated ${fn}`).toBe(false);
        expect(await db.hasFunctionPrivilege('service_role', fn), `service_role ${fn}`).toBe(true);
      }
      expect(await db.hasFunctionPrivilege('anon', 'xp_award_attempts_forget_check_in()')).toBe(false);
      expect(await db.hasFunctionPrivilege('authenticated', 'xp_award_attempts_forget_check_in()')).toBe(false);
    });

    it('a client role calling the functions or reading the table gets permission denied', async () => {
      const id = await db.createCheckIn(user.id, recipe1, slot1);
      for (const role of ['anon', 'authenticated']) {
        for (const sql of [
          'SELECT * FROM xp_award_attempts',
          "SELECT * FROM get_xp_reconcile_candidates(NOW() - interval '1 day', NOW(), 10, 5, 10)",
          "SELECT * FROM list_xp_reconcile_given_up(NOW() - interval '1 day', NOW(), 5, 10)",
          "SELECT count_xp_reconcile_given_up(NOW() - interval '1 day', NOW(), 5)",
          `SELECT record_xp_award_attempt('${id}', 'path', 'http')`,
        ]) {
          const client = await db.getPool().connect();
          try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL ROLE ${role}`);
            await expect(client.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/i);
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        }
      }
    });
  });
});
