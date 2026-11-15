import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * 20261115000000_plan_badges_recipe_book.sql
 *
 * F2 plan (done / current / locked, suggested sessions), path gating,
 * F8 mastery reveal counts, F9 badges, F10 recipe book, F4 video cache grants.
 * Everything is derived from check_ins, so these tests create check-ins the
 * way the ai-server does (service role) and read back through the RPCs.
 */
describe('plan, badges and recipe book', () => {
  let db: TestDatabase;
  let user: TestUser;
  let other: TestUser;

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
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    user = await db.createTestUser(`test-plan-${stamp}@example.com`);
    other = await db.createTestUser(`test-plan-other-${stamp}@example.com`);
    await db.createProfile(user.id); // 3 days/week, 30 min/session
    await db.createProfile(other.id);
  });

  /** Run a query as an authenticated client (RLS + grants apply). */
  async function asUser<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Run a query as a given role with no user (anon / service_role). */
  async function asRole<T = Record<string, unknown>>(role: 'anon' | 'service_role', sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Cook a slot: recipe (once) + check-in + XP award, like the ai-server. */
  async function cook(
    u: TestUser,
    slotOrder: number,
    opts: { rating?: 'easy' | 'ok' | 'hard'; hidden?: number; revealed?: number; at?: string } = {}
  ): Promise<string> {
    const slotId = await db.getSlotId(slotOrder);
    const existing = await db.getPool().query(
      'SELECT id FROM user_recipes WHERE user_id = $1 AND slot_id = $2',
      [u.id, slotId]
    );
    const recipeId: string = existing.rows[0]?.id ?? (await db.createUserRecipe(u.id, slotId));
    const result = await db.getPool().query(
      `INSERT INTO check_ins (user_id, user_recipe_id, slot_id, difficulty_rating, hidden_steps, revealed_steps, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
       RETURNING id`,
      [u.id, recipeId, slotId, opts.rating ?? 'ok', opts.hidden ?? null, opts.revealed ?? null, opts.at ?? null]
    );
    const checkInId: string = result.rows[0].id;
    await db.awardSlotXp(checkInId);
    return checkInId;
  }

  async function cookThrough(u: TestUser, lastSlotOrder: number): Promise<string[]> {
    const ids: string[] = [];
    for (let order = 1; order <= lastSlotOrder; order++) {
      ids.push(await cook(u, order, { at: `2026-11-0${Math.min(order, 9)}T12:00:00Z` }));
    }
    return ids;
  }

  interface PlanRow {
    slot_order: number;
    status: string;
    has_recipe: boolean;
    times_completed: number;
    is_final: boolean;
    xp_value: number;
  }

  describe('F2 plan: get_my_plan', () => {
    it('new user: slot 1 current, slots 2-10 locked, slot 10 final', async () => {
      const plan = await asUser<PlanRow>(user.id, 'SELECT * FROM get_my_plan()');
      expect(plan).toHaveLength(10);
      expect(plan.map((p) => p.status)).toEqual([
        'current', 'locked', 'locked', 'locked', 'locked',
        'locked', 'locked', 'locked', 'locked', 'locked',
      ]);
      expect(plan.filter((p) => p.is_final).map((p) => p.slot_order)).toEqual([10]);
      expect(plan.map((p) => p.xp_value)).toEqual([102, 62, 75, 143, 65, 105, 137, 80, 148, 181]);
    });

    it('a check-in marks the slot done and unlocks only the next one', async () => {
      await cook(user, 1);
      await cook(user, 2);
      const plan = await asUser<PlanRow>(user.id, 'SELECT * FROM get_my_plan()');
      expect(plan.slice(0, 4).map((p) => p.status)).toEqual(['done', 'done', 'current', 'locked']);
      expect(plan[0].has_recipe).toBe(true);
      expect(plan[2].has_recipe).toBe(false);
    });

    it('repeats count toward times_completed but not toward the path', async () => {
      await cook(user, 1);
      await cook(user, 1, { rating: 'hard' });
      const plan = await asUser<PlanRow>(user.id, 'SELECT * FROM get_my_plan()');
      expect(plan[0]).toMatchObject({ status: 'done', times_completed: 2 });
      expect(plan[1].status).toBe('current');
    });

    it("only shows the caller's own progress", async () => {
      await cook(other, 1);
      const plan = await asUser<PlanRow>(user.id, 'SELECT * FROM get_my_plan()');
      expect(plan[0].status).toBe('current');
    });

    it('all done: no current slot', async () => {
      await cookThrough(user, 10);
      const plan = await asUser<PlanRow>(user.id, 'SELECT * FROM get_my_plan()');
      expect(plan.every((p) => p.status === 'done')).toBe(true);
    });

    it('anon cannot call it', async () => {
      await expect(asRole('anon', 'SELECT * FROM get_my_plan()')).rejects.toThrow(/permission denied/);
    });
  });

  describe('F2/F7 summary: get_my_plan_summary', () => {
    interface Summary {
      total_xp: number;
      completed_slots: number;
      total_slots: number;
      current_slot_order: number | null;
      path_complete: boolean;
      suggested_sessions_per_week: number | null;
      estimated_weeks_remaining: number | null;
    }

    it('new user (3 days x 30 min): 2 sessions/week, 5 weeks', async () => {
      // avg cook_minutes = (20+10+18+35+18+25+38+20+40+80)/10 = 30.4
      // floor(3*30 / 30.4) = floor(2.96) = 2 sessions; ceil(10 / 2) = 5 weeks
      const [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s).toMatchObject({
        total_xp: 0,
        completed_slots: 0,
        total_slots: 10,
        current_slot_order: 1,
        path_complete: false,
        suggested_sessions_per_week: 2,
        estimated_weeks_remaining: 5,
      });
    });

    it('caps suggestions at days_per_week and floors at 1', async () => {
      await db.getPool().query('UPDATE profiles SET days_per_week = 2, minutes_per_session = 240 WHERE id = $1', [user.id]);
      let [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s.suggested_sessions_per_week).toBe(2);

      await db.getPool().query('UPDATE profiles SET days_per_week = 7, minutes_per_session = 5 WHERE id = $1', [user.id]);
      [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s.suggested_sessions_per_week).toBe(1);
      expect(s.estimated_weeks_remaining).toBe(10);
    });

    it('no schedule yet: suggestion is null', async () => {
      await db.getPool().query('UPDATE profiles SET days_per_week = NULL, minutes_per_session = NULL WHERE id = $1', [user.id]);
      const [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s.suggested_sessions_per_week).toBeNull();
      expect(s.estimated_weeks_remaining).toBeNull();
    });

    it('tracks total XP and progress, including a finished path', async () => {
      await cook(user, 1);
      await cook(user, 2);
      let [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s).toMatchObject({ total_xp: 102 + 62, completed_slots: 2, current_slot_order: 3 });

      await cleanAndFinish();
      [s] = await asUser<Summary>(user.id, 'SELECT * FROM get_my_plan_summary()');
      expect(s).toMatchObject({ completed_slots: 10, current_slot_order: null, path_complete: true, estimated_weeks_remaining: 0 });
    });

    async function cleanAndFinish(): Promise<void> {
      for (let order = 3; order <= 10; order++) await cook(user, order);
    }
  });

  describe('path gating: is_slot_unlocked (service role)', () => {
    async function unlocked(u: TestUser, order: number): Promise<boolean> {
      const slotId = await db.getSlotId(order);
      const [row] = await asRole<{ ok: boolean }>('service_role', 'SELECT is_slot_unlocked($1, $2) AS ok', [u.id, slotId]);
      return row.ok;
    }

    it('current and done slots are open, locked ones are not', async () => {
      expect(await unlocked(user, 1)).toBe(true);
      expect(await unlocked(user, 2)).toBe(false);
      await cook(user, 1);
      expect(await unlocked(user, 1)).toBe(true); // repeat allowed
      expect(await unlocked(user, 2)).toBe(true);
      expect(await unlocked(user, 3)).toBe(false);
    });

    it('unknown slot is not unlocked', async () => {
      const [row] = await asRole<{ ok: boolean }>('service_role', 'SELECT is_slot_unlocked($1, 9999) AS ok', [user.id]);
      expect(row.ok).toBe(false);
    });

    it('clients cannot call it', async () => {
      await expect(asUser(user.id, 'SELECT is_slot_unlocked($1, 1)', [user.id])).rejects.toThrow(/permission denied/);
    });
  });

  describe('F9 badges', () => {
    interface Badge {
      code: string;
      kind: string;
      earned: boolean;
      earned_at: Date | null;
    }

    it('lists 9 completion, 1 mastery and 1 path milestone badge, all locked for a new user', async () => {
      const badges = await asUser<Badge>(user.id, 'SELECT * FROM get_my_badges()');
      expect(badges).toHaveLength(11);
      expect(badges.filter((b) => b.kind === 'completion')).toHaveLength(9);
      expect(badges.filter((b) => b.kind === 'mastery')).toHaveLength(1);
      expect(badges.filter((b) => b.kind === 'path_milestone')).toHaveLength(1);
      expect(badges.every((b) => !b.earned)).toBe(true);
    });

    it('a check-in earns that slot badge once; a repeat earns nothing new', async () => {
      const first = await cook(user, 1);
      const repeat = await cook(user, 1);

      const earnedFirst = await asRole<{ code: string }>('service_role', 'SELECT code FROM get_badges_earned_by_check_in($1)', [first]);
      const earnedRepeat = await asRole<{ code: string }>('service_role', 'SELECT code FROM get_badges_earned_by_check_in($1)', [repeat]);
      expect(earnedFirst.map((b) => b.code)).toEqual(['complete_slot_1']);
      expect(earnedRepeat).toEqual([]);

      const badges = await asUser<Badge>(user.id, 'SELECT * FROM get_my_badges()');
      expect(badges.filter((b) => b.earned).map((b) => b.code)).toEqual(['complete_slot_1']);
    });

    it('slot 10 earns mastery and, as the last slot, the path milestone', async () => {
      const ids = await cookThrough(user, 9);
      const last = await cook(user, 10, { hidden: 2, revealed: 1, at: '2026-11-10T12:00:00Z' });

      const earned = await asRole<{ code: string }>('service_role', 'SELECT code FROM get_badges_earned_by_check_in($1)', [last]);
      expect(earned.map((b) => b.code)).toEqual(['mastery', 'path_weeknight_basics']);

      const ninth = await asRole<{ code: string }>('service_role', 'SELECT code FROM get_badges_earned_by_check_in($1)', [ids[8]]);
      expect(ninth.map((b) => b.code)).toEqual(['complete_slot_9']);

      const badges = await asUser<Badge>(user.id, 'SELECT * FROM get_my_badges()');
      expect(badges.every((b) => b.earned)).toBe(true);
    });

    it('badges are per user', async () => {
      await cook(other, 1);
      const badges = await asUser<Badge>(user.id, 'SELECT * FROM get_my_badges()');
      expect(badges.some((b) => b.earned)).toBe(false);
    });

    it('clients cannot call the per-check-in helper or write badges', async () => {
      const id = await cook(user, 1);
      await expect(asUser(user.id, 'SELECT * FROM get_badges_earned_by_check_in($1)', [id])).rejects.toThrow(/permission denied/);
      await expect(
        asUser(user.id, `INSERT INTO badges (code, name, description, kind, sort_order) VALUES ('x', 'x', 'x', 'path_milestone', 1)`)
      ).rejects.toThrow(/permission denied/);
    });

    it('the per-check-in helper rejects an unknown check-in', async () => {
      await expect(
        asRole('service_role', 'SELECT * FROM get_badges_earned_by_check_in(gen_random_uuid())')
      ).rejects.toThrow(/Invalid or non-existent check_in_id/);
    });
  });

  describe('F10 recipe book', () => {
    interface Entry {
      slot_order: number;
      label: string;
      recipe_title: string;
      times_cooked: number;
      user_recipe_id: string;
    }

    it('empty for a new user', async () => {
      expect(await asUser(user.id, 'SELECT * FROM get_my_recipe_book()')).toEqual([]);
    });

    it('one Completed entry per slot even when cooked twice', async () => {
      await cook(user, 1);
      await cook(user, 1);
      await cook(user, 2);
      const book = await asUser<Entry>(user.id, 'SELECT * FROM get_my_recipe_book()');
      expect(book.map((e) => [e.slot_order, e.label, e.times_cooked])).toEqual([
        [1, 'completed', 2],
        [2, 'completed', 1],
      ]);
      expect(book[0].recipe_title).toBe('Test Recipe');
      expect(book[0].user_recipe_id).toBeTruthy();
    });

    it('the final slot is Mastered', async () => {
      await cookThrough(user, 10);
      const book = await asUser<Entry>(user.id, 'SELECT * FROM get_my_recipe_book()');
      expect(book).toHaveLength(10);
      expect(book.filter((e) => e.label === 'mastered').map((e) => e.slot_order)).toEqual([10]);
    });
  });

  describe('F8 mastery reveal counts', () => {
    it('stored on the final slot', async () => {
      await cookThrough(user, 9);
      const id = await cook(user, 10, { hidden: 3, revealed: 1 });
      const row = await db.getPool().query('SELECT hidden_steps, revealed_steps FROM check_ins WHERE id = $1', [id]);
      expect(row.rows[0]).toEqual({ hidden_steps: 3, revealed_steps: 1 });
    });

    it('rejected on any other slot', async () => {
      await expect(cook(user, 1, { hidden: 3, revealed: 1 })).rejects.toThrow(/only allowed for the mastery slot/);
    });

    it('revealed cannot exceed hidden, and both must be set together', async () => {
      await cookThrough(user, 9);
      await expect(cook(user, 10, { hidden: 2, revealed: 3 })).rejects.toThrow(/check_ins_mastery_counts_check/);
      await expect(cook(user, 10, { hidden: 2 })).rejects.toThrow(/check_ins_mastery_counts_check/);
    });
  });

  describe('grants', () => {
    it('clients cannot rewrite check-in history', async () => {
      const id = await cook(user, 1);
      await expect(
        asUser(user.id, `UPDATE check_ins SET created_at = NOW() - interval '30 days' WHERE id = $1`, [id])
      ).rejects.toThrow(/permission denied/);
      await expect(asUser(user.id, 'DELETE FROM check_ins WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
    });

    it('clients cannot see or write the video cache', async () => {
      await expect(asUser(user.id, 'SELECT * FROM technique_videos')).rejects.toThrow(/permission denied/);
      await expect(asRole('anon', 'SELECT * FROM technique_videos')).rejects.toThrow(/permission denied/);
    });

    it('internal per-user helpers are not callable by clients', async () => {
      for (const fn of [
        'get_plan_for_user($1)',
        'get_plan_summary_for_user($1)',
        'get_badges_for_user($1)',
        'get_recipe_book_for_user($1)',
        'first_check_ins_for_user($1)',
      ]) {
        await expect(asUser(user.id, `SELECT * FROM ${fn}`, [other.id])).rejects.toThrow(/permission denied/);
      }
    });

    it('function privileges match the design', async () => {
      const clientRpcs = ['get_my_plan()', 'get_my_plan_summary()', 'get_my_badges()', 'get_my_recipe_book()'];
      for (const fn of clientRpcs) {
        expect(await db.hasFunctionPrivilege('authenticated', fn)).toBe(true);
        expect(await db.hasFunctionPrivilege('anon', fn)).toBe(false);
      }
      for (const fn of ['is_slot_unlocked(uuid,integer)', 'get_badges_earned_by_check_in(uuid)']) {
        expect(await db.hasFunctionPrivilege('service_role', fn)).toBe(true);
        expect(await db.hasFunctionPrivilege('authenticated', fn)).toBe(false);
        expect(await db.hasFunctionPrivilege('anon', fn)).toBe(false);
      }
    });
  });
});
