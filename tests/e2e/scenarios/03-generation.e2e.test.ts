/** F3: real recipe generation of slot 1 through Ollama, saved and reused. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSlot } from '../helpers/ai.js';
import type { Json } from '../helpers/http.js';
import { getPlan } from '../helpers/game.js';
import { rest, svcRest } from '../helpers/supabase.js';
import { Cast, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let user: E2eUser;
beforeAll(async () => {
  user = await cast.newUser();
});
afterAll(() => cast.cleanup());

// Subset of the server's own keyword list (ai-server recipe-generator SAFETY_KEYWORDS).
const SAFETY = /\b(heat|hot|boil|boiling|simmer|bake|roast|grill|broil|stove|oven|knife|knives|cut|chop|dice|slice|mince|fry|sear)\b/i;

describe('F3 real generation (slot 1)', () => {
  let first: Json;
  let firstMs = 0;

  it('generates a schema-valid recipe via Ollama', async () => {
    const plan = await getPlan(user);
    const slot1 = plan[0].slot_id;
    const res = await generateSlot(user.accessToken, slot1);
    firstMs = res.ms;
    console.log(`[timing] real generation of slot 1: ${(res.ms / 1000).toFixed(1)}s (attempts to avoid 429: ${res.attempts})`);
    expect(res.status).toBe(200);
    first = res.body;
    expect(first.cached).toBe(false);
    const r = first.recipe;
    expect(typeof r.title).toBe('string');
    expect(r.title.length).toBeGreaterThan(0);
    expect(Array.isArray(r.ingredients) && r.ingredients.length).toBeGreaterThan(0);
    for (const ing of r.ingredients) {
      expect(typeof ing.name).toBe('string');
      expect(typeof ing.amount).toBe('string');
    }
    expect(Number.isInteger(r.timeEstimateMinutes) && r.timeEstimateMinutes > 0).toBe(true);
    expect(r.steps.length).toBeGreaterThan(0);
    for (const step of r.steps) {
      expect(typeof step.instruction).toBe('string');
      expect(step.instruction.length).toBeGreaterThan(0);
      expect(typeof step.isSafetyStep).toBe('boolean');
    }
    expect(first.videos).toBeTypeOf('object'); // {} while YouTube is off
  });

  it('flags heat / knife steps as safety steps', () => {
    const steps: Json[] = first.recipe.steps;
    expect(steps.some((s) => s.isSafetyStep)).toBe(true);
    for (const s of steps) {
      if (SAFETY.test(s.instruction)) {
        expect(s.isSafetyStep, `step "${s.instruction}" should be a safety step`).toBe(true);
      }
    }
  });

  it('saved the recipe (plan has_recipe, one user_recipes row, stored JSON equals the response)', async () => {
    const plan = await getPlan(user);
    expect(plan[0].has_recipe).toBe(true);
    const own = await rest(user.accessToken, 'user_recipes?select=id,slot_id');
    expect(own.body).toHaveLength(1);
    // INSPECTION (service role): the stored recipe_json is what the user was shown.
    const stored = await svcRest(`user_recipes?select=recipe_json&user_id=eq.${user.id}`);
    expect(stored.body).toHaveLength(1);
    expect(stored.body[0].recipe_json).toEqual(first.recipe);
  });

  it('second call returns the same saved recipe, instantly, not regenerated', async () => {
    const plan = await getPlan(user);
    const res = await generateSlot(user.accessToken, plan[0].slot_id);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.recipe).toEqual(first.recipe);
    console.log(`[timing] cached read: ${res.ms}ms (first generation was ${(firstMs / 1000).toFixed(1)}s)`);
    expect(res.ms).toBeLessThan(5000);
    const own = await rest(user.accessToken, 'user_recipes?select=id');
    expect(own.body).toHaveLength(1);
  });
});
