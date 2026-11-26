import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createPathRecipeService } from '../services/path-recipe-service.js';
import type { SupabaseService } from '../services/supabase.js';
import { OllamaBusyError } from '../services/ollama-gate.js';
import type { Recipe } from '../schemas/recipe.js';

const recipe: Recipe = {
  title: 'Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs well', isSafetyStep: false }],
};
const slot = { id: 2, dishName: 'Eggs', techniqueFocus: 'Heat', isFinal: false };
const profile = { id: 'u1', experienceLevel: 'never_cooked' as const, budget: 'low' as const, equipment: ['pan'] };

function makeSupabase(overrides: Partial<Record<keyof SupabaseService, unknown>> = {}): SupabaseService {
  return {
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'u1' }),
    getUserProfile: vi.fn().mockResolvedValue(profile),
    getPathSlot: vi.fn().mockResolvedValue(slot),
    isSlotUnlocked: vi.fn().mockResolvedValue(true),
    getSavedRecipe: vi.fn().mockResolvedValue(null),
    getSavedVideos: vi.fn().mockResolvedValue(null),
    saveVideos: vi.fn().mockResolvedValue(undefined),
    saveRecipe: vi.fn().mockImplementation((_u: string, _s: number, r: Recipe) => Promise.resolve(r)),
    ...overrides,
  } as unknown as SupabaseService;
}

describe('recipe route during a prewarm', () => {
  it('joins the in-flight generation: one model call', async () => {
    let release: (v: string) => void = () => undefined;
    const ollamaClient = {
      generate: vi.fn().mockImplementation(() => new Promise<string>((r) => { release = r; })),
    };
    const supabase = makeSupabase();
    const pathRecipes = createPathRecipeService({ ollamaClient, supabase });
    const app = express();
    app.use(express.json());
    app.use('/api/recipes', createRecipeRouter({ ollamaClient, supabase, pathRecipes }));

    const prewarm = pathRecipes.generate('u1', slot, profile);
    await vi.waitFor(() => expect(ollamaClient.generate).toHaveBeenCalledTimes(1));
    const pending = request(app).post('/api/recipes/generate/2').set('Authorization', 'Bearer t').send({});
    const responsePromise = pending.then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    release(JSON.stringify(recipe));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect(ollamaClient.generate).toHaveBeenCalledTimes(1);
  });

  it('a joined request gets the 500 and generation error when the prewarm fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail: (e: Error) => void = () => undefined;
    const ollamaClient = {
      generate: vi
        .fn()
        .mockImplementationOnce(() => new Promise<string>((_r, reject) => { fail = reject; }))
        .mockRejectedValue(new Error('model down')),
    };
    const supabase = makeSupabase();
    const pathRecipes = createPathRecipeService({ ollamaClient, supabase });
    const app = express();
    app.use(express.json());
    app.use('/api/recipes', createRecipeRouter({ ollamaClient, supabase, pathRecipes }));

    const prewarm = pathRecipes.generate('u1', slot, profile);
    await vi.waitFor(() => expect(ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = request(app).post('/api/recipes/generate/2').set('Authorization', 'Bearer t').send({}).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    fail(new Error('model down'));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(500);
    expect(response.body.type).toBe('generation_failed');
    expect(response.body.attempts).toBe(3);
    expect(ollamaClient.generate).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  }, 10000);

  it('a joined request gets 503 GENERATION_BUSY when the prewarm is refused as busy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let refuse: (e: Error) => void = () => undefined;
    const ollamaClient = {
      generate: vi.fn().mockImplementation(() => new Promise<string>((_r, reject) => { refuse = reject; })),
    };
    const supabase = makeSupabase();
    const pathRecipes = createPathRecipeService({ ollamaClient, supabase });
    const app = express();
    app.use(express.json());
    app.use('/api/recipes', createRecipeRouter({ ollamaClient, supabase, pathRecipes }));

    const prewarm = pathRecipes.generate('u1', slot, profile);
    await vi.waitFor(() => expect(ollamaClient.generate).toHaveBeenCalledTimes(1));
    const responsePromise = request(app).post('/api/recipes/generate/2').set('Authorization', 'Bearer t').send({}).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    refuse(new OllamaBusyError('queue_timeout'));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('GENERATION_BUSY');
    expect(ollamaClient.generate).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('a route request already in its DB reads joins a prewarm that starts meanwhile: one model call', async () => {
    let releaseProfile: (p: typeof profile) => void = () => undefined;
    let release: (v: string) => void = () => undefined;
    const ollamaClient = {
      generate: vi.fn().mockImplementation(() => new Promise<string>((r) => { release = r; })),
    };
    const supabase = makeSupabase({
      // Only the route's first read waits; the stale-check re-read answers at once.
      getUserProfile: vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => { releaseProfile = r as typeof releaseProfile; }))
        .mockResolvedValue(profile),
    });
    const pathRecipes = createPathRecipeService({ ollamaClient, supabase });
    const app = express();
    app.use(express.json());
    app.use('/api/recipes', createRecipeRouter({ ollamaClient, supabase, pathRecipes }));

    // The route starts first and stops at the profile read.
    const responsePromise = request(app).post('/api/recipes/generate/2').set('Authorization', 'Bearer t').send({}).then((r) => r);
    await vi.waitFor(() => expect(supabase.getUserProfile).toHaveBeenCalledTimes(1));
    // The prewarm starts generating, then the route reaches generate and joins it.
    const prewarm = pathRecipes.generate('u1', slot, profile);
    await vi.waitFor(() => expect(ollamaClient.generate).toHaveBeenCalledTimes(1));
    releaseProfile(profile);
    await new Promise((r) => setTimeout(r, 20));
    release(JSON.stringify(recipe));
    const [response] = await Promise.all([responsePromise, prewarm]);

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect(ollamaClient.generate).toHaveBeenCalledTimes(1);
    expect(supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });
});
