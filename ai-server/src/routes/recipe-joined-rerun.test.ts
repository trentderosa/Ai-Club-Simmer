import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createPathRecipeService } from '../services/path-recipe-service.js';
import type { OllamaBudget } from '../services/ollama-budget.js';
import type { SupabaseService } from '../services/supabase.js';
import { OllamaBusyError, OllamaPreemptedError } from '../services/ollama-gate.js';
import type { Recipe } from '../schemas/recipe.js';

const recipe: Recipe = {
  title: 'Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs well', isSafetyStep: false }],
};
const masteryRecipe: Recipe = {
  ...recipe,
  steps: [
    { instruction: 'Whisk the eggs until smooth', isSafetyStep: false, techniqueName: 'Whisk eggs' },
    { instruction: 'Cook on low heat', isSafetyStep: true, techniqueName: 'Low heat cooking' },
    { instruction: 'Season the eggs with salt', isSafetyStep: false },
    { instruction: 'Bake in the oven for ten minutes', isSafetyStep: true },
    { instruction: 'Let them rest on a plate', isSafetyStep: false },
    { instruction: 'Serve', isSafetyStep: false },
  ],
};
const rinseRecipe: Recipe = {
  ...recipe,
  title: 'Chicken',
  steps: [{ instruction: 'Rinse the chicken under cold water.', isSafetyStep: false }],
};
const profile = { id: 'u1', experienceLevel: 'never_cooked' as const, budget: 'low' as const, equipment: ['pan'] };

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(slotId = 2, generationBudget?: OllamaBudget, hooks?: { beforeRerun?: () => void }) {
  const slot = { id: slotId, dishName: 'Eggs', techniqueFocus: 'Heat', isFinal: slotId === 10 };
  const pending: Array<{ resolve: (t: string) => void; reject: (e: Error) => void }> = [];
  const ollamaClient = {
    generate: vi.fn().mockImplementation(
      () => new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))
    ),
  };
  const supabase = {
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'u1' }),
    getUserProfile: vi.fn().mockResolvedValue(profile),
    getPathSlot: vi.fn().mockResolvedValue(slot),
    isSlotUnlocked: vi.fn().mockResolvedValue(true),
    getSavedRecipe: vi.fn().mockResolvedValue(null),
    getSavedVideos: vi.fn().mockResolvedValue(null),
    saveVideos: vi.fn().mockResolvedValue(undefined),
    saveRecipe: vi.fn().mockImplementation((_u: string, _s: number, r: Recipe) => Promise.resolve(r)),
  } as unknown as SupabaseService;
  const pathRecipes = createPathRecipeService({ ollamaClient, supabase, generationBudget, hooks });
  const app = express();
  app.use(express.json());
  app.use('/api/recipes', createRecipeRouter({ ollamaClient, supabase, pathRecipes, generationBudget }));
  const post = (): Promise<request.Response> =>
    request(app).post(`/api/recipes/generate/${slotId}`).set('Authorization', 'Bearer t').send({}).then((r) => r);
  const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 20));
  return { slot, pending, ollamaClient, supabase, pathRecipes, post, settle };
}

describe('recipe route joining a background generation', () => {
  let warn: { mock: { calls: unknown[][] } };
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reruns when the prewarm is refused as busy (immediateOnly)', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    t.pending[1].resolve(JSON.stringify(recipe));
    const [response, bg] = await Promise.all([responsePromise, prewarm]);

    expect(bg.success).toBe(false);
    expect(response.status).toBe(200);
    expect(response.body.recipe.title).toBe('Eggs');
    expect(warn).toHaveBeenCalledWith('recipe_joined_generation_rerun', { slot_id: 2, reason: 'busy' });
    // The rerun is a foreground call: it may queue.
    expect(t.ollamaClient.generate.mock.calls[1][2]?.background).toBeUndefined();
  });

  it('reruns when the prewarm skipped its retries', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true, shouldRetry: () => false });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new Error('model down'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    t.pending[1].resolve(JSON.stringify(recipe));
    const [response, bg] = await Promise.all([responsePromise, prewarm]);

    expect(bg).toMatchObject({ success: false, error: { retrySkipped: true } });
    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith('recipe_joined_generation_rerun', { slot_id: 2, reason: 'retry_skipped' });
  });

  it('does not rerun a prewarm that failed all 3 attempts', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new Error('model down'));
    for (let i = 1; i < 3; i++) {
      await vi.waitFor(() => expect(t.pending.length).toBe(i + 1), { timeout: 3000 });
      t.pending[i].reject(new Error('model down'));
    }
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(500);
    expect(response.body.attempts).toBe(3);
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalledWith('recipe_joined_generation_rerun', expect.anything());
  }, 10000);

  it('a joiner of a foreground generation that ended busy gets busy, no rerun', async () => {
    const t = setup();
    const first = t.pathRecipes.generate('u1', t.slot, profile);
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    const [response] = await Promise.all([responsePromise, first]);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('GENERATION_BUSY');
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1);
  });

  it('a background joiner of a prewarm that ended busy does not rerun', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const second = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    const [bg, joined] = await Promise.all([prewarm, second]);

    expect(bg.success).toBe(false);
    expect(joined).toMatchObject({ success: false, error: { type: 'busy' } });
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith('recipe_joined_generation_rerun', expect.anything());
  });

  it('two joiners share one rerun', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const a = t.post();
    const b = t.post();
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    await t.settle();
    t.pending[1].resolve(JSON.stringify(recipe));
    const [ra, rb] = await Promise.all([a, b, prewarm]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2);
    expect(t.supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });

  it('the rerun honors the remaining budget: exhausted returns 503', async () => {
    let clock = 0;
    const t = setup(2, { budgetMs: 1000, ollamaTimeoutMs: 100, queueTimeoutMs: 500, now: () => clock });
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    clock = 5000;
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('GENERATION_BUSY');
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1);
  });

  it('slot 10 output from a rerun is still masked', async () => {
    const t = setup(10);
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    t.pending[1].resolve(JSON.stringify(masteryRecipe));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(200);
    const steps = response.body.recipe.steps as Array<{ isHidden?: boolean }>;
    expect(steps.map((s) => s.isHidden ?? false)).toEqual([true, false, true, false, true, true]);
    expect(JSON.stringify(response.body)).not.toContain('Whisk the eggs');
  });

  it('a prewarm that skipped its retries after a flagged rinse saves nothing; the joiner reruns clean', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true, shouldRetry: () => false });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].resolve(JSON.stringify(rinseRecipe));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2), { timeout: 3000 });
    t.pending[1].resolve(JSON.stringify(recipe));
    const [response, bg] = await Promise.all([responsePromise, prewarm]);

    expect(bg).toMatchObject({ success: false, error: { retrySkipped: true } });
    expect(response.status).toBe(200);
    expect(response.body.recipe.title).toBe('Eggs');
    expect(t.supabase.saveRecipe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('recipe_joined_generation_rerun', { slot_id: 2, reason: 'retry_skipped' });
  }, 10000);

  it('a prewarm alone that skipped its retries after a flagged rinse saves nothing', async () => {
    const t = setup();
    const prewarm = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true, shouldRetry: () => false });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    t.pending[0].resolve(JSON.stringify(rinseRecipe));
    const bg = await prewarm;

    expect(bg).toMatchObject({ success: false, error: { retrySkipped: true } });
    expect(t.supabase.saveRecipe).not.toHaveBeenCalled();
  }, 10000);

  it('stranded joiners wait for a new prewarm and rerun once, sharing that rerun', async () => {
    let armed = false;
    let newPrewarm: Promise<unknown> | undefined;
    const hook = { t: undefined as unknown as ReturnType<typeof setup> };
    const t = setup(2, { budgetMs: 100000, ollamaTimeoutMs: 1000, queueTimeoutMs: 1000 }, {
      beforeRerun: () => {
        // Runs inside the joiner, after the first prewarm is gone and before its run():
        // a new prewarm registers in that gap.
        if (!armed) return;
        armed = false;
        newPrewarm = hook.t.pathRecipes.generate('u1', hook.t.slot, profile, { immediateOnly: true });
      },
    });
    hook.t = t;
    const first = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const a = t.post();
    const b = t.post();
    await t.settle();
    armed = true;
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    await t.settle();
    expect(newPrewarm).toBeDefined();
    expect(t.ollamaClient.generate.mock.calls[1][2]?.background).toBe(true);
    // No third model call yet: the joiners wait for the new prewarm, not replace it.
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2);
    t.pending[1].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(3));
    await t.settle();
    expect(t.ollamaClient.generate.mock.calls[2][2]?.background).toBeUndefined();
    t.pending[2].resolve(JSON.stringify(recipe));
    const [ra, rb] = await Promise.all([a, b, first, newPrewarm]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(3);
    expect(t.supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });

  it('a stranded joiner whose newer prewarm fails validation after 3 attempts gets that failure, no rerun', async () => {
    let armed = false;
    let newPrewarm: Promise<unknown> | undefined;
    const hook = { t: undefined as unknown as ReturnType<typeof setup> };
    const t = setup(2, undefined, {
      beforeRerun: () => {
        if (!armed) return;
        armed = false;
        newPrewarm = hook.t.pathRecipes.generate('u1', hook.t.slot, profile, { immediateOnly: true });
      },
    });
    hook.t = t;
    const first = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    armed = true;
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    expect(newPrewarm).toBeDefined();
    // Valid JSON that fails the recipe schema, on every attempt of the newer prewarm.
    t.pending[1].resolve('{}');
    for (let i = 2; i < 4; i++) {
      await vi.waitFor(() => expect(t.pending.length).toBe(i + 1), { timeout: 3000 });
      t.pending[i].resolve('{}');
    }
    const [response, , bg] = await Promise.all([responsePromise, first, newPrewarm]);

    expect(bg).toMatchObject({ success: false, error: { type: 'validation_failed', attempts: 3 } });
    expect(response.status).toBe(500);
    expect(response.body.attempts).toBe(3);
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(4);
    expect(t.supabase.saveRecipe).not.toHaveBeenCalled();
    // Only the first rerun decision (the busy first prewarm) was logged.
    expect(warn.mock.calls.filter((c) => c[0] === 'recipe_joined_generation_rerun')).toHaveLength(1);
  }, 10000);

  it('a third prewarm registering before the joiner resumes: the foreground replaces it and is not deleted by its finally', async () => {
    let calls = 0;
    const hook = { t: undefined as unknown as ReturnType<typeof setup> };
    const t = setup(2, undefined, {
      beforeRerun: () => {
        // Call 1: the joiner leaves the first prewarm (registers the second).
        // Call 2: the joiner leaves the second (registers a third).
        calls += 1;
        if (calls <= 2) {
          void hook.t.pathRecipes.generate('u1', hook.t.slot, profile, { immediateOnly: true });
        }
      },
    });
    hook.t = t;
    const first = t.pathRecipes.generate('u1', t.slot, profile, { immediateOnly: true });
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = t.post();
    await t.settle();
    t.pending[0].reject(new OllamaBusyError('queue_timeout'));
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(2));
    await t.settle();
    t.pending[1].reject(new OllamaBusyError('queue_timeout'));
    // Third prewarm (call 3) and the joiner's foreground (call 4).
    await vi.waitFor(() => expect(t.ollamaClient.generate).toHaveBeenCalledTimes(4));
    expect(t.ollamaClient.generate.mock.calls[2][2]?.background).toBe(true);
    expect(t.ollamaClient.generate.mock.calls[3][2]?.background).toBeUndefined();
    // The gate would preempt the prewarm for the real request.
    t.pending[2].reject(new OllamaPreemptedError());
    await t.settle();
    // The preempted prewarm's finally must not delete the foreground entry:
    // a late request still joins it instead of starting a fifth call.
    const late = t.post();
    await t.settle();
    expect(t.ollamaClient.generate).toHaveBeenCalledTimes(4);
    t.pending[3].resolve(JSON.stringify(recipe));
    const [response, lateResponse] = await Promise.all([responsePromise, late, first]);

    expect(response.status).toBe(200);
    expect(lateResponse.status).toBe(200);
    expect(response.body.recipe.title).toBe('Eggs');
    expect(t.supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });
});
