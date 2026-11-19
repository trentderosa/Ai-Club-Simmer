/**
 * F8 mastery challenge (slot 10).
 *
 * SETUP NOTE: to reach slot 10 quickly, slots 1-9 get a valid minimal recipe
 * seeded with the service role, then are completed with REAL check-ins (that is
 * what unlocks slot 10). User A's slot 10 recipe is generated for real through
 * Ollama. User B (zero-reveal path) has a seeded slot 10 recipe so the masking
 * and session checks are deterministic. With E2E_REAL_GENERATION=1 every
 * recipe (slots 1-9 and B's slot 10) is generated for real instead.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ai, generateSlot, postCheckIn } from '../helpers/ai.js';
import { completeSlots, getBadges, getPlan, getRecipeBook, getSummary, pathSlots, recordTiming, seedRecipe, storedRecipe, userRecipeId } from '../helpers/game.js';
import type { Json } from '../helpers/http.js';
import { rest, svcRest } from '../helpers/supabase.js';
import { Cast, type E2eUser } from '../helpers/users.js';

const LONG = 1_200_000;
const PLACEHOLDER_HINT = /hidden step/i;
const cast = new Cast();
let A: E2eUser;
let B: E2eUser;
let ids: number[] = [];
let slot10: number;
let slot10Xp: number;

beforeAll(async () => {
  A = await cast.newUser();
  B = await cast.newUser();
  const slots = await pathSlots();
  ids = slots.map((s) => s.id);
  slot10 = ids[9];
  slot10Xp = slots[9].xp_value;
});
afterAll(() => cast.cleanup());

function hiddenIdx(recipe: Json): number[] {
  return recipe.steps.flatMap((s: Json, i: number) => (s.isSafetyStep ? [] : [i]));
}

function assertMasked(masked: Json, real: Json): void {
  expect(masked.steps).toHaveLength(real.steps.length);
  real.steps.forEach((realStep: Json, i: number) => {
    const m = masked.steps[i];
    if (realStep.isSafetyStep) {
      expect(m.isHidden, `safety step ${i} must stay visible`).toBeUndefined();
      expect(m.instruction).toBe(realStep.instruction);
      expect(m.isSafetyStep).toBe(true);
    } else {
      expect(m.isHidden, `step ${i}`).toBe(true);
      expect(m.instruction).not.toBe(realStep.instruction);
      expect(m.instruction).toMatch(PLACEHOLDER_HINT);
      expect(m.whyItMatters).toBeUndefined();
    }
  });
  const wire = JSON.stringify(masked);
  real.steps.forEach((realStep: Json) => {
    if (!realStep.isSafetyStep) {
      expect(wire).not.toContain(realStep.instruction);
      if (realStep.whyItMatters) expect(wire).not.toContain(realStep.whyItMatters);
    }
  });
}

describe('F8 user A: reveals one step', () => {
  let real: Json; // INSPECTION (service role): the stored full recipe
  let sessionId: string;
  let hidden: number[];

  it('completes slots 1-9 with real check-ins so slot 10 unlocks', async () => {
    await completeSlots(A, ids.slice(0, 9));
    const plan = await getPlan(A);
    expect(plan.slice(0, 9).every((p) => p.status === 'done')).toBe(true);
    expect(plan[9].status).toBe('current');
  }, LONG);

  it('generates slot 10 for real; hidden steps are masked, safety steps visible', async () => {
    const res = await generateSlot(A.accessToken, slot10);
    recordTiming('real generation (06 slot 10)', slot10, res.ms, { status: res.status });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    const stored = await svcRest(`user_recipes?select=recipe_json&user_id=eq.${A.id}&slot_id=eq.${slot10}`);
    real = stored.body[0].recipe_json;
    hidden = hiddenIdx(real);
    assertMasked(res.body.recipe, real);
    console.log(`[info] slot 10 recipe: ${real.steps.length} steps, ${hidden.length} hidden`);
    expect(hidden.length, 'model produced a recipe with no non-safety steps; nothing to hide').toBeGreaterThan(0);
  });

  it('cached read of slot 10 is masked too', async () => {
    const res = await generateSlot(A.accessToken, slot10);
    expect(res.body.cached).toBe(true);
    assertMasked(res.body.recipe, real);
  });

  it('start session returns hidden indices; starting again resumes the same session', async () => {
    const res = await ai('/api/mastery/sessions', { token: A.accessToken, body: { slot_id: slot10 } });
    expect(res.status).toBe(201);
    sessionId = res.body.session_id;
    expect(res.body.hidden_step_indices).toEqual(hidden);
    expect(res.body.revealed_steps).toEqual({});
    const again = await ai('/api/mastery/sessions', { token: A.accessToken, body: { slot_id: slot10 } });
    expect(again.body.session_id).toBe(sessionId);
  });

  it('session errors: non-final slot, other user cannot reveal on it', async () => {
    const notFinal = await ai('/api/mastery/sessions', { token: A.accessToken, body: { slot_id: ids[0] } });
    expect(notFinal.status).toBe(400);
    expect(notFinal.body.code).toBe('SLOT_NOT_FINAL');
    const bNoRecipe = await ai('/api/mastery/sessions', { token: B.accessToken, body: { slot_id: slot10 } });
    expect(bNoRecipe.status).toBe(404);
    expect(bNoRecipe.body.code).toBe('RECIPE_NOT_FOUND');
    const steal = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: B.accessToken, body: { step_index: hidden[0] } });
    expect(steal.status).toBe(404);
    expect(steal.body.code).toBe('MASTERY_SESSION_NOT_FOUND');
    expect(JSON.stringify(steal.body)).not.toContain(real.steps[hidden[0]].instruction);
  });

  it('cannot reveal a safety step or an out-of-range index', async () => {
    const safetyIdx = real.steps.findIndex((s: Json) => s.isSafetyStep);
    if (safetyIdx >= 0) {
      const r = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: A.accessToken, body: { step_index: safetyIdx } });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('STEP_NOT_HIDDEN');
    }
    const oob = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: A.accessToken, body: { step_index: real.steps.length } });
    expect(oob.status).toBe(400);
  });

  it('reveal returns the real text and counts once, even if repeated', async () => {
    const h0 = hidden[0];
    const r1 = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: A.accessToken, body: { step_index: h0 } });
    expect(r1.status).toBe(200);
    expect(r1.body.step.instruction).toBe(real.steps[h0].instruction);
    expect(r1.body.revealed_step_indices).toEqual([h0]);
    const r2 = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: A.accessToken, body: { step_index: h0 } });
    expect(r2.status).toBe(200);
    expect(r2.body.revealed_step_indices).toEqual([h0]);
    const resumed = await ai('/api/mastery/sessions', { token: A.accessToken, body: { slot_id: slot10 } });
    expect(resumed.body.session_id).toBe(sessionId);
    expect(Object.keys(resumed.body.revealed_steps)).toEqual([String(h0)]);
    expect(resumed.body.revealed_steps[h0].instruction).toBe(real.steps[h0].instruction);
  });

  it('check-in WITHOUT a session that claims revealed_steps 0 earns no mastery badge', async () => {
    const res = await postCheckIn(A.accessToken, {
      user_recipe_id: await userRecipeId(A, slot10),
      slot_id: slot10,
      rating: 'ok',
      idempotency_key: randomUUID(),
      mastery: { hidden_steps: hidden.length, revealed_steps: 0 },
    });
    expect(res.status).toBe(201);
    const codes = res.body.badges.earned.map((b: Json) => b.code);
    expect(codes).not.toContain('mastery');
    expect(res.body.xp).toMatchObject({ status: 'awarded', xp_awarded: slot10Xp, is_first_completion: true });
    // finishing slot 10 last earns the path badge
    expect(codes).toContain('path_weeknight_basics');
    const row = await svcRest(`check_ins?select=hidden_steps,revealed_steps&id=eq.${res.body.check_in_id}`);
    expect(row.body[0]).toEqual({ hidden_steps: null, revealed_steps: null });
  });

  it('check-in WITH the session uses the session count (1 reveal), not the claimed 0', async () => {
    const res = await postCheckIn(A.accessToken, {
      user_recipe_id: await userRecipeId(A, slot10),
      slot_id: slot10,
      rating: 'easy',
      mastery_session_id: sessionId,
      idempotency_key: randomUUID(),
      mastery: { hidden_steps: hidden.length, revealed_steps: 0 },
    });
    expect(res.status).toBe(201);
    expect(res.body.badges.earned.map((b: Json) => b.code)).not.toContain('mastery');
    const row = await svcRest(`check_ins?select=hidden_steps,revealed_steps,mastery_session_id&id=eq.${res.body.check_in_id}`);
    expect(row.body[0]).toEqual({ hidden_steps: hidden.length, revealed_steps: 1, mastery_session_id: sessionId });
    const mastery = (await getBadges(A)).find((b) => b.code === 'mastery');
    expect(mastery.earned).toBe(false);
  });

  it('the used session cannot be reused or revealed on; bogus sessions are rejected', async () => {
    const reuse = await postCheckIn(A.accessToken, {
      user_recipe_id: await userRecipeId(A, slot10), slot_id: slot10, rating: 'ok', mastery_session_id: sessionId,
    });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe('MASTERY_SESSION_USED');
    const reveal = await ai(`/api/mastery/sessions/${sessionId}/reveal`, { token: A.accessToken, body: { step_index: hidden[hidden.length - 1] } });
    expect(reveal.status).toBe(409);
    expect(reveal.body.code).toBe('MASTERY_SESSION_USED');
    const bogus = await postCheckIn(A.accessToken, {
      user_recipe_id: await userRecipeId(A, slot10), slot_id: slot10, rating: 'ok', mastery_session_id: randomUUID(),
    });
    expect(bogus.status).toBe(400);
    expect(bogus.body.code).toBe('INVALID_MASTERY_SESSION');
  });

  it('recipe book shows slot 10 as Mastered; path is complete', async () => {
    const book = await getRecipeBook(A);
    const entry = book.find((b) => b.slot_id === slot10);
    expect(entry.label).toBe('mastered');
    expect(book).toHaveLength(10);
    const s = await getSummary(A);
    expect(s).toMatchObject({ completed_slots: 10, path_complete: true });
    const earned = (await getBadges(A)).filter((b) => b.earned).map((b) => b.code);
    expect(earned).toContain('path_weeknight_basics');
    expect(earned).not.toContain('mastery');
  });
});

describe('F8 user B: zero-reveal run earns the mastery badge', () => {
  let sessionId: string;
  let bReal: Json; // INSPECTION (service role): B's stored slot 10 recipe

  it('completes slots 1-9, then has a (seeded) slot 10 recipe', async () => {
    await completeSlots(B, ids.slice(0, 9));
    await seedRecipe(B, slot10);
    bReal = await storedRecipe(B, slot10);
    expect(hiddenIdx(bReal).length, 'slot 10 recipe has no non-safety steps; nothing to hide').toBeGreaterThan(0);
    expect((await getPlan(B))[9].status).toBe('current');
  }, LONG);

  it('slot 10 recipe is masked, safety step visible', async () => {
    const res = await generateSlot(B.accessToken, slot10);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    assertMasked(res.body.recipe, bReal);
  });

  it('starts a session and checks in with zero reveals', async () => {
    const start = await ai('/api/mastery/sessions', { token: B.accessToken, body: { slot_id: slot10 } });
    expect(start.status).toBe(201);
    sessionId = start.body.session_id;
    expect(start.body.hidden_step_indices).toEqual(hiddenIdx(bReal));
    const res = await postCheckIn(B.accessToken, {
      user_recipe_id: await userRecipeId(B, slot10), slot_id: slot10, rating: 'easy',
      mastery_session_id: sessionId, idempotency_key: randomUUID(),
    });
    expect(res.status).toBe(201);
    const codes = res.body.badges.earned.map((b: Json) => b.code);
    expect(codes).toContain('mastery');
    expect(codes).toContain('path_weeknight_basics');
    expect(res.body.xp).toMatchObject({ status: 'awarded', xp_awarded: slot10Xp, is_first_completion: true });
    const row = await rest(B.accessToken, `check_ins?select=hidden_steps,revealed_steps&slot_id=eq.${slot10}`);
    expect(row.body).toEqual([{ hidden_steps: hiddenIdx(bReal).length, revealed_steps: 0 }]);
  });

  it('badges screen and recipe book agree', async () => {
    const earned = (await getBadges(B)).filter((b) => b.earned).map((b) => b.code);
    expect(earned).toContain('mastery');
    expect(earned).toContain('path_weeknight_basics');
    expect((await getRecipeBook(B)).find((b) => b.slot_id === slot10).label).toBe('mastered');
  });
});
