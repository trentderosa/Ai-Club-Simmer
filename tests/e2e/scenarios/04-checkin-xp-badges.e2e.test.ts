/**
 * F6 / F7 / F9 / F10: check-in on slot 1, XP, badge, unlock, recipe book,
 * idempotency, repeat rules and caps.
 *
 * SETUP NOTE: slot 1's recipe is seeded with the service role (a valid minimal
 * recipe) instead of a real Ollama generation, which 03-generation covers.
 * Everything under test (check-in, XP, badges, unlock, book) is the real path.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSlot, postCheckIn } from '../helpers/ai.js';
import {
  getBadges, getPlan, getRecipeBook, getSummary, modelAward, pathCheckIn, pathSlots,
  readXpState, seedRecipe, userRecipeId, xpConfig, type XpConfig,
} from '../helpers/game.js';
import { rest, svcRest } from '../helpers/supabase.js';
import { Cast, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let user: E2eUser;
let other: E2eUser;
let slot1Id: number;
let slot1Xp: number;
let cfg: XpConfig;
const key = randomUUID();
let firstCheckInBody: Record<string, unknown>;

beforeAll(async () => {
  user = await cast.newUser();
  other = await cast.newUser();
  const slots = await pathSlots();
  slot1Id = slots[0].id;
  slot1Xp = slots[0].xp_value;
  cfg = await xpConfig();
  await seedRecipe(user, slot1Id);
  await seedRecipe(other, slot1Id);
});
afterAll(() => cast.cleanup());

describe('F6/F7/F9/F10 first check-in on slot 1', () => {
  it('awards the path_slots XP server-side, earns the completion badge', async () => {
    const user_recipe_id = await userRecipeId(user, slot1Id);
    firstCheckInBody = { user_recipe_id, slot_id: slot1Id, rating: 'ok', went_well: 'Even cuts', idempotency_key: key };
    const res = await postCheckIn(user.accessToken, firstCheckInBody);
    expect(res.status).toBe(201);
    expect(res.body.check_in_id).toBe(key);
    expect(typeof res.body.coach_note).toBe('string');
    expect(res.body.xp).toEqual({ status: 'awarded', xp_awarded: slot1Xp, is_first_completion: true, capped: false });
    expect(res.body.badges.status).toBe('ok');
    expect(res.body.badges.earned.map((b: { code: string }) => b.code)).toContain('complete_slot_1');
    expect(res.body.badges.earned[0].kind).toBe('completion');
    expect(res.body.suggest_repeat).toBe(false);
  });

  it('xp_events row exists, plan unlocks slot 2, summary total matches', async () => {
    const events = await rest(user.accessToken, 'xp_events?select=check_in_id,xp_awarded,is_first_completion');
    expect(events.body).toEqual([{ check_in_id: key, xp_awarded: slot1Xp, is_first_completion: true }]);
    const plan = await getPlan(user);
    expect(plan[0]).toMatchObject({ status: 'done', times_completed: 1 });
    expect(plan[1].status).toBe('current');
    expect(plan.slice(2).every((p) => p.status === 'locked')).toBe(true);
    const s = await getSummary(user);
    expect(s).toMatchObject({ total_xp: slot1Xp, completed_slots: 1, current_slot_order: 2 });
  });

  it('badge screen shows complete_slot_1 earned; others not', async () => {
    const badges = await getBadges(user);
    const earned = badges.filter((b) => b.earned).map((b) => b.code);
    expect(earned).toEqual(['complete_slot_1']);
  });

  it('recipe book has the slot 1 entry as completed, cooked once', async () => {
    const book = await getRecipeBook(user);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ slot_id: slot1Id, label: 'completed', times_cooked: 1 });
  });

  it('retrying the SAME idempotency_key returns the original and awards nothing more', async () => {
    const res = await postCheckIn(user.accessToken, firstCheckInBody);
    expect(res.status).toBe(201);
    expect(res.body.check_in_id).toBe(key);
    const events = await rest(user.accessToken, 'xp_events?select=id');
    expect(events.body).toHaveLength(1);
    const rows = await rest(user.accessToken, 'check_ins?select=id');
    expect(rows.body).toHaveLength(1);
    expect((await getSummary(user)).total_xp).toBe(slot1Xp);
    expect((await getPlan(user))[0].times_completed).toBe(1);
  });

  it('an idempotency_key owned by another user is 409 IDEMPOTENCY_CONFLICT', async () => {
    const res = await postCheckIn(other.accessToken, {
      user_recipe_id: await userRecipeId(other, slot1Id),
      slot_id: slot1Id,
      rating: 'ok',
      idempotency_key: key,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    // and nothing was written for the other user
    expect((await rest(other.accessToken, 'check_ins?select=id')).body).toEqual([]);
  });
});

describe('F7 repeats: 50%, weekly repeat cap, then 0', () => {
  it('repeat #1 is 50% of the slot XP', async () => {
    const res = await pathCheckIn(user, slot1Id, { rating: 'ok' });
    const state = await readXpState(user, res.body.check_in_id);
    const expected = modelAward({ base: slot1Xp, isFirst: false, cfg, state, applyDailyCap: false });
    expect(res.status).toBe(201);
    expect(res.body.xp).toEqual({ status: 'awarded', xp_awarded: expected.xp, is_first_completion: false, capped: expected.capped });
    expect(expected.xp).toBe(Math.floor((slot1Xp * cfg.repeatPct) / 100));
    expect(res.body.badges.earned).toEqual([]); // a repeat earns nothing new
    expect(res.body.suggest_repeat).toBe(false);
  });

  it('repeat #2 rated hard: suggest_repeat true, XP follows the weekly cap', async () => {
    const res = await pathCheckIn(user, slot1Id, { rating: 'hard', was_hard: 'Dicing' });
    const state = await readXpState(user, res.body.check_in_id);
    const expected = modelAward({ base: slot1Xp, isFirst: false, cfg, state, applyDailyCap: false });
    expect(res.status).toBe(201);
    expect(res.body.suggest_repeat).toBe(true);
    expect(res.body.xp).toEqual({ status: 'awarded', xp_awarded: expected.xp, is_first_completion: false, capped: expected.capped });
  });

  it('keeps repeating until the cap: weekly repeat XP never exceeds the cap, then awards 0 with capped true', async () => {
    for (let i = 0; i < 4; i += 1) {
      const res = await pathCheckIn(user, slot1Id, { rating: 'easy' });
      const state = await readXpState(user, res.body.check_in_id);
      const expected = modelAward({ base: slot1Xp, isFirst: false, cfg, state, applyDailyCap: false });
      expect(res.status).toBe(201);
      expect(res.body.xp.status).toBe('awarded');
      expect(res.body.xp.xp_awarded).toBe(expected.xp);
      expect(res.body.xp.capped).toBe(expected.capped);
    }
    const after = await readXpState(user);
    expect(after.weeklyRepeatUsed).toBe(cfg.weeklyCap);
    const last = await pathCheckIn(user, slot1Id, { rating: 'ok' });
    expect(last.body.xp).toEqual({ status: 'awarded', xp_awarded: 0, is_first_completion: false, capped: true });
    expect((await getSummary(user)).total_xp).toBe(slot1Xp + cfg.weeklyCap);
    expect((await getPlan(user))[0].times_completed).toBeGreaterThanOrEqual(7);
  });
});

describe('check-in validation and auth', () => {
  it('rejects bad payloads with 400 VALIDATION_ERROR', async () => {
    const recipeId = await userRecipeId(user, slot1Id);
    const cases: Array<Record<string, unknown>> = [
      { user_recipe_id: recipeId, slot_id: slot1Id, rating: 'great' },
      { user_recipe_id: recipeId, slot_id: slot1Id },
      { user_recipe_id: recipeId, rating: 'ok' },
      { rating: 'ok' },
      { user_recipe_id: recipeId, slot_id: slot1Id, rating: 'ok', generated_recipe_id: randomUUID() },
      { user_recipe_id: recipeId, slot_id: slot1Id, rating: 'ok', went_well: 'x'.repeat(501) },
      { user_recipe_id: 'not-a-uuid', slot_id: slot1Id, rating: 'ok' },
    ];
    for (const body of cases) {
      const res = await postCheckIn(user.accessToken, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it("another user's recipe or a slot mismatch is 400 INVALID_RECIPE", async () => {
    const theirs = await userRecipeId(other, slot1Id);
    const res = await postCheckIn(user.accessToken, { user_recipe_id: theirs, slot_id: slot1Id, rating: 'ok' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RECIPE');
    const mine = await userRecipeId(user, slot1Id);
    const wrongSlot = await postCheckIn(user.accessToken, { user_recipe_id: mine, slot_id: slot1Id + 1, rating: 'ok' });
    expect(wrongSlot.status).toBe(400);
    expect(wrongSlot.body.code).toBe('INVALID_RECIPE');
  });

  it('mastery_session_id on a non-final slot is 400', async () => {
    const res = await pathCheckIn(user, slot1Id, { mastery_session_id: randomUUID() });
    expect(res.status).toBe(400);
    expect(['MASTERY_NOT_ALLOWED', 'INVALID_MASTERY_SESSION']).toContain(res.body.code);
  });

  it('no token is 401', async () => {
    const res = await postCheckIn('', { rating: 'ok' });
    expect(res.status).toBe(401);
  });
});

describe('F10 recipe book: documented full-recipe read', () => {
  it('a book entry cannot read recipe_json directly (migration 20261116000000 revokes it from clients)', async () => {
    // Intended: clients can't read recipe_json, so slot 10 hidden steps can't leak.
    // docs/CLIENT_API.md F10 used to show this direct read; it is now documented as blocked.
    const book = await getRecipeBook(user);
    const res = await rest(user.accessToken, `user_recipes?select=recipe_json,video_ids&id=eq.${book[0].user_recipe_id}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('"steps"');
  });

  it('a book entry opens its full recipe through the AI server, as the app does', async () => {
    // app/src/app/(tabs)/book.tsx opens /recipe/[slotId], which calls POST /api/recipes/generate/:slotId.
    const book = await getRecipeBook(user);
    const res = await generateSlot(user.accessToken, book[0].slot_id);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.recipe.title).toBe(book[0].recipe_title);
    expect(res.body.recipe.steps.length).toBeGreaterThan(0);
  });

  it('INSPECTION: the book entry points at the stored recipe', async () => {
    const book = await getRecipeBook(user);
    const stored = await svcRest(`user_recipes?select=recipe_json&id=eq.${book[0].user_recipe_id}`);
    expect(book[0].recipe_title).toBe(stored.body[0].recipe_json.title);
  });
});
