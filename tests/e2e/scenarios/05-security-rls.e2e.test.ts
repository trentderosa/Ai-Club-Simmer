/**
 * Security / RLS with two real users. A owns data, B (and the anon key alone)
 * try to read or change it.
 *
 * SETUP NOTES (service role): A's slot 1 (generated for real with
 * E2E_REAL_GENERATION=1) and slot 10 recipes, a mastery
 * session and a Cook anything recipe are inserted directly so there is private
 * data to attack. A's slot 1 check-in and XP go through the real AI server.
 * `pg` (DB_URL) is used only to confirm no rows changed.
 */
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ai } from '../helpers/ai.js';
import { env } from '../helpers/env.js';
import { pathCheckIn, pathSlots, seedRecipe, seedRecipeDirect, storedRecipe, userRecipeId } from '../helpers/game.js';
import type { Json } from '../helpers/http.js';
import { expectOk, rest, rpc, svcRest } from '../helpers/supabase.js';
import { Cast, ONBOARDING, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let A: E2eUser;
let B: E2eUser;
let aCheckInId: string;
let aRecipeId: string;
let aSlot10RecipeId: string;
let aSlot1Title: string;
let slot1: number;
let slot10: number;
let pool: pg.Pool;

async function countFor(userId: string): Promise<Record<string, number>> {
  const q = async (sql: string) => Number((await pool.query(sql, [userId])).rows[0].n);
  return {
    check_ins: await q('select count(*) n from check_ins where user_id = $1'),
    xp_events: await q('select count(*) n from xp_events where user_id = $1'),
    user_recipes: await q('select count(*) n from user_recipes where user_id = $1'),
    completions: await q('select count(*) n from user_slot_completions where user_id = $1'),
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: env().dbUrl, max: 2 });
  A = await cast.newUser();
  B = await cast.newUser();
  const slots = await pathSlots();
  slot1 = slots[0].id;
  slot10 = slots[9].id;
  aRecipeId = await seedRecipe(A, slot1);
  const res = await pathCheckIn(A, slot1);
  aCheckInId = expectOk(res, 'A check-in').check_in_id;
  aSlot1Title = (await storedRecipe(A, slot1)).title;
  // Slot 10 is locked for A, so it is always a stored seed (generation would refuse it).
  aSlot10RecipeId = await seedRecipeDirect(A, slot10);
  expectOk(
    await svcRest('mastery_sessions', {
      method: 'POST',
      body: { user_id: A.id, user_recipe_id: aSlot10RecipeId, slot_id: slot10, hidden_step_indices: [0, 2, 3] },
    }),
    'seed mastery session'
  );
  expectOk(
    await svcRest('user_generated_recipes', {
      method: 'POST',
      body: {
        user_id: A.id, dish_query: 'secret dish', normalized_dish_name: 'secret dish',
        recipe_json: { title: 'Secret' }, step_count: 3, ingredient_count: 3, time_estimate_minutes: 10, xp_value: 50,
      },
    }),
    'seed generated recipe'
  );
});
afterAll(async () => {
  await pool.end();
  await cast.cleanup();
});

describe('user B cannot read user A private data', () => {
  it('profiles', async () => {
    const byId = await rest(B.accessToken, `profiles?select=*&id=eq.${A.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual([]);
    const all = await rest(B.accessToken, 'profiles?select=id');
    expect(all.body).toEqual([{ id: B.id }]);
  });

  it('check_ins', async () => {
    const res = await rest(B.accessToken, `check_ins?select=*&user_id=eq.${A.id}`);
    expect(res.body).toEqual([]);
    expect((await rest(B.accessToken, 'check_ins?select=id')).body).toEqual([]);
    expect((await rest(A.accessToken, 'check_ins?select=id')).body).toEqual([{ id: aCheckInId }]);
  });

  it('xp_events', async () => {
    expect((await rest(B.accessToken, `xp_events?select=*&user_id=eq.${A.id}`)).body).toEqual([]);
    expect((await rest(A.accessToken, 'xp_events?select=id')).body).toHaveLength(1);
  });

  it('user_recipes: recipe_json is unreadable for everyone on the client; B sees none of A rows', async () => {
    const asB = await rest(B.accessToken, `user_recipes?select=recipe_json&id=eq.${aRecipeId}`);
    expect([401, 403]).toContain(asB.status);
    expect(JSON.stringify(asB.body)).not.toContain(aSlot1Title);
    const rowsB = await rest(B.accessToken, `user_recipes?select=id,user_id,slot_id&user_id=eq.${A.id}`);
    expect(rowsB.body).toEqual([]);
    // even the owner cannot read recipe_json from the client (hidden steps of slot 10)
    const asA = await rest(A.accessToken, `user_recipes?select=recipe_json&id=eq.${aSlot10RecipeId}`);
    expect([401, 403]).toContain(asA.status);
    // select * must not leak it either
    const star = await rest(A.accessToken, `user_recipes?select=*&id=eq.${aSlot10RecipeId}`);
    expect(JSON.stringify(star.body)).not.toContain('Slice the tomato');
  });

  it('mastery_sessions is invisible to clients', async () => {
    for (const u of [A, B]) {
      const res = await rest(u.accessToken, 'mastery_sessions?select=*');
      expect([401, 403]).toContain(res.status);
      expect(Array.isArray(res.body) ? res.body : []).toEqual([]);
    }
  });

  it('user_generated_recipes (Cook anything) recipe_json', async () => {
    const asB = await rest(B.accessToken, `user_generated_recipes?select=recipe_json&user_id=eq.${A.id}`);
    expect(asB.body).toEqual([]);
    const own = await rest(A.accessToken, 'user_generated_recipes?select=normalized_dish_name');
    expect(own.body).toEqual([{ normalized_dish_name: 'secret dish' }]);
  });

  it('badges / completions / recipe book RPCs only show the caller', async () => {
    const bBook = await rpc(B.accessToken, 'get_my_recipe_book');
    expect(bBook.body).toEqual([]);
    const bCompletions = await rest(B.accessToken, 'user_slot_completions?select=*');
    expect(bCompletions.body).toEqual([]);
  });
});

describe('anon key alone gets nothing private', () => {
  const tables = [
    'profiles', 'check_ins', 'xp_events', 'user_recipes', 'user_generated_recipes',
    'user_slot_completions', 'generated_recipe_check_ins', 'generated_recipe_xp_events',
    'mastery_sessions', 'technique_videos', 'dish_photos',
  ];
  for (const t of tables) {
    it(`${t}`, async () => {
      const res = await rest(null, `${t}?select=*`);
      const rows = Array.isArray(res.body) ? res.body : [];
      expect(rows, `${t} returned rows to anon (HTTP ${res.status})`).toEqual([]);
    });
  }
  it('plan / badge / book RPCs refuse anon', async () => {
    for (const fn of ['get_my_plan', 'get_my_plan_summary', 'get_my_badges', 'get_my_recipe_book']) {
      const res = await rpc(null, fn);
      expect([401, 403], fn).toContain(res.status);
    }
  });
});

describe('privileged functions are not callable from the client', () => {
  it('authenticated user cannot call award_slot_xp / award_generated_recipe_xp', async () => {
    const before = await countFor(A.id);
    for (const [fn, args] of [
      ['award_slot_xp', { p_check_in_id: aCheckInId }],
      ['award_generated_recipe_xp', { p_check_in_id: aCheckInId }],
    ] as const) {
      const res = await rpc(A.accessToken, fn, args);
      expect([401, 403], `${fn} -> HTTP ${res.status}`).toContain(res.status);
      expect(res.body.code).toBe('42501');
    }
    expect(await countFor(A.id)).toEqual(before);
  });

  it('authenticated user cannot call start_mastery_session / reveal_mastery_step / is_slot_unlocked', async () => {
    for (const [fn, args] of [
      ['start_mastery_session', { p_user_id: A.id, p_slot_id: slot10 }],
      ['reveal_mastery_step', { p_user_id: A.id, p_session_id: randomUUID(), p_step_index: 0 }],
      ['is_slot_unlocked', { p_user_id: A.id, p_slot_id: slot1 }],
      ['get_badges_earned_by_check_in', { p_check_in_id: aCheckInId }],
    ] as const) {
      for (const who of [A, B]) {
        const res = await rpc(who.accessToken, fn, args);
        expect([401, 403], `${fn} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`).toContain(res.status);
      }
      const anon = await rpc(null, fn, args);
      expect([401, 403], `${fn} anon`).toContain(anon.status);
    }
  });

  it('client cannot insert check_ins directly (A with own recipe, B with A recipe)', async () => {
    const before = await countFor(A.id);
    const mk = (u: E2eUser, recipeId: string) =>
      rest(u.accessToken, 'check_ins', {
        method: 'POST',
        body: { user_id: u.id, user_recipe_id: recipeId, slot_id: slot1, difficulty_rating: 'easy' },
      });
    const own = await mk(A, aRecipeId);
    expect([401, 403]).toContain(own.status);
    const cross = await mk(B, aRecipeId);
    expect([401, 403]).toContain(cross.status);
    expect(await countFor(A.id)).toEqual(before);
    expect((await countFor(B.id)).check_ins).toBe(0);
  });

  it('client cannot write xp_events, user_recipes, badges, completions, or update/delete check_ins', async () => {
    const before = await countFor(A.id);
    const attempts: Array<[string, string, unknown]> = [
      ['POST', 'xp_events', { user_id: A.id, check_in_id: aCheckInId, slot_id: slot1, xp_awarded: 9999, is_first_completion: true }],
      ['POST', 'user_recipes', { user_id: A.id, slot_id: slot1 + 1, recipe_json: { title: 'x' } }],
      ['POST', 'user_slot_completions', { user_id: A.id, slot_id: slot1 + 1 }],
      ['POST', 'badges', { code: 'hacked', name: 'x', description: 'x', kind: 'completion' }],
      ['PATCH', `check_ins?id=eq.${aCheckInId}`, { difficulty_rating: 'hard' }],
      ['DELETE', `check_ins?id=eq.${aCheckInId}`, undefined],
      ['PATCH', `xp_events?check_in_id=eq.${aCheckInId}`, { xp_awarded: 9999 }],
      ['DELETE', `xp_events?check_in_id=eq.${aCheckInId}`, undefined],
      ['PATCH', `user_recipes?id=eq.${aRecipeId}`, { recipe_json: { title: 'pwned' } }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await rest(A.accessToken, path, { method, body, prefer: 'return=representation' });
      const rows = Array.isArray(res.body) ? res.body : [];
      expect(res.status >= 400 || rows.length === 0, `${method} ${path} -> HTTP ${res.status}`).toBe(true);
    }
    expect(await countFor(A.id)).toEqual(before);
    const check = await svcRest(`check_ins?select=difficulty_rating&id=eq.${aCheckInId}`);
    expect(check.body[0].difficulty_rating).toBe('ok');
    const xp = await svcRest(`xp_events?select=xp_awarded&check_in_id=eq.${aCheckInId}`);
    expect(xp.body[0].xp_awarded).toBeLessThan(9999);
  });

  it('B cannot create or edit A profile', async () => {
    const insert = await rest(B.accessToken, 'profiles', {
      method: 'POST',
      body: { id: A.id, ...ONBOARDING, goals: 'pwned' },
    });
    expect([401, 403]).toContain(insert.status);
    const upsert = await rest(B.accessToken, 'profiles?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { id: A.id, ...ONBOARDING, goals: 'pwned' },
    });
    expect([401, 403]).toContain(upsert.status);
    const patch = await rest(B.accessToken, `profiles?id=eq.${A.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { goals: 'pwned' },
    });
    expect(Array.isArray(patch.body) ? patch.body : []).toEqual([]);
    const mine = await rest(A.accessToken, 'profiles?select=goals');
    expect(mine.body).toEqual([{ goals: ONBOARDING.goals }]);
  });
});

function b64(obj: Json): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('AI server rejects bad tokens with 401', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { sub: randomUUID(), role: 'authenticated', aud: 'authenticated', iat: nowSec - 7200, exp: nowSec - 3600 };
  const expiredLooking = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('x'.repeat(64)).toString('base64url')}`;
  const forgedHs256 = (() => {
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ ...claims, exp: nowSec + 3600 });
    const sig = createHmac('sha256', 'not-the-secret').update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  })();
  const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, exp: nowSec + 3600 })}.`;

  const endpoints: Array<[string, Json]> = [
    ['/api/recipes/generate/1', {}],
    ['/api/recipes/cook-anything', { dish: 'pad thai' }],
    ['/api/check-ins', { rating: 'ok', generated_recipe_id: randomUUID() }],
    ['/api/mastery/sessions', { slot_id: 10 }],
    [`/api/mastery/sessions/${randomUUID()}/reveal`, { step_index: 0 }],
    ['/api/dish-photos', { dishes: ['pad thai'] }],
  ];
  const tokens: Array<[string, { token?: string; rawAuthHeader?: string }]> = [
    ['missing', {}],
    ['garbage', { token: 'garbage' }],
    ['not a bearer header', { rawAuthHeader: 'Basic abc' }],
    ['expired-looking ES256', { token: expiredLooking }],
    ['HS256 forged with a wrong secret', { token: forgedHs256 }],
    ['alg none', { token: algNone }],
  ];
  for (const [path, body] of endpoints) {
    it(`${path.replace(/[0-9a-f-]{36}/, ':id')}`, async () => {
      for (const [label, t] of tokens) {
        const res = await ai(path, { body, ...t });
        expect(res.status, `${label} -> ${path}`).toBe(401);
      }
    });
  }
});

it('A still has exactly the data it started with (nothing above changed it)', async () => {
  expect(await countFor(A.id)).toMatchObject({ check_ins: 1, xp_events: 1, completions: 1 });
  expect((await userRecipeId(A, slot1)).length).toBeGreaterThan(10);
});
