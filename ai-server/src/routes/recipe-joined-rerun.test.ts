import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createPathRecipeService } from '../services/path-recipe-service.js';
import type { OllamaBudget } from '../services/ollama-budget.js';
import type { SupabaseService } from '../services/supabase.js';
import { OllamaBusyError } from '../services/ollama-gate.js';
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
const profile = { id: 'u1', experienceLevel: 'never_cooked' as const, budget: 'low' as const, equipment: ['pan'] };

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(slotId = 2, generationBudget?: OllamaBudget) {
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
  const pathRecipes = createPathRecipeService({ ollamaClient, supabase, generationBudget });
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
});
