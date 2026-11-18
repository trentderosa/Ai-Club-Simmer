/**
 * XP retry scheduler (PR #30): a saved check-in with no award is picked up by
 * the in-server scheduler and awarded exactly once.
 *
 * SETUP: the AI server only leaves a check-in without XP when the live award
 * fails (timeout, 5xx). To produce that state deterministically we insert the
 * check-ins with the service role, which does NOT run award_slot_xp (that is
 * the same end state as a failed award). `pg` (DB_URL) is used only to count
 * xp_events rows, an inspection the app cannot do.
 *
 * Needs the server's scheduler running (XP_RECONCILE_INTERVAL_MS) with a short
 * XP_RECONCILE_MIN_AGE_SECONDS, see the README section.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../helpers/env.js';
import { getPlan, getSummary, pathSlots, seedRecipe, userRecipeId, xpConfig } from '../helpers/game.js';
import { sleep } from '../helpers/http.js';
import { expectOk, rest, svcRest } from '../helpers/supabase.js';
import { Cast, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let user: E2eUser;
let pool: pg.Pool;
let slot1: { id: number; xp_value: number };
const olderId = randomUUID();
const newerId = randomUUID();

const countEvents = async (): Promise<number> =>
  Number((await pool.query('select count(*) n from xp_events where user_id = $1', [user.id])).rows[0].n);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: env().dbUrl, max: 2 });
  user = await cast.newUser();
  slot1 = (await pathSlots())[0];
  await seedRecipe(user, slot1.id);
});
afterAll(async () => {
  await pool.end();
  await cast.cleanup();
});

describe('XP retry scheduler', () => {
  it('SETUP: two saved check-ins on slot 1 with no award', async () => {
    const recipeId = await userRecipeId(user, slot1.id);
    const now = Date.now();
    for (const [id, ageSec] of [[olderId, 120], [newerId, 110]] as const) {
      expectOk(
        await svcRest('check_ins', {
          method: 'POST',
          body: {
            id, user_id: user.id, user_recipe_id: recipeId, slot_id: slot1.id,
            difficulty_rating: 'ok', created_at: new Date(now - ageSec * 1000).toISOString(),
          },
        }),
        'insert check-in without award'
      );
    }
    expect(await countEvents()).toBe(0);
    expect((await getSummary(user)).total_xp).toBe(0);
  });

  it('within ~150 s the scheduler awards both, oldest first, exactly one row each', async () => {
    const deadline = Date.now() + 150_000;
    let n = 0;
    while (Date.now() < deadline) {
      n = await countEvents();
      if (n >= 2) break;
      await sleep(5000);
    }
    expect(n, 'scheduler did not award both check-ins within 150 s').toBe(2);

    const cfg = await xpConfig();
    const rows = (await rest(user.accessToken, 'xp_events?select=check_in_id,xp_awarded,is_first_completion')).body as Array<{
      check_in_id: string; xp_awarded: number; is_first_completion: boolean;
    }>;
    const older = rows.find((r) => r.check_in_id === olderId)!;
    const newer = rows.find((r) => r.check_in_id === newerId)!;
    expect(older).toEqual({ check_in_id: olderId, xp_awarded: slot1.xp_value, is_first_completion: true });
    expect(newer).toEqual({
      check_in_id: newerId,
      xp_awarded: Math.floor((slot1.xp_value * cfg.repeatPct) / 100),
      is_first_completion: false,
    });
    const expectedTotal = older.xp_awarded + newer.xp_awarded;
    expect((await getSummary(user)).total_xp).toBe(expectedTotal);
    const plan = await getPlan(user);
    expect(plan[0]).toMatchObject({ status: 'done', times_completed: 2 });
    expect(plan[1].status).toBe('current');
  });

  it('later scheduler ticks do not award again', async () => {
    const before = await countEvents();
    await sleep(130_000); // two more ticks at a 60 s interval
    expect(await countEvents()).toBe(before);
    const dupes = await pool.query(
      'select check_in_id, count(*) n from xp_events where user_id = $1 group by 1 having count(*) > 1',
      [user.id]
    );
    expect(dupes.rows).toEqual([]);
    const s = await getSummary(user);
    expect(s.total_xp).toBe(slot1.xp_value + Math.floor(slot1.xp_value / 2));
  });
});
