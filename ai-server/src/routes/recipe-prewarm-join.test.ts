import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createPathRecipeService } from '../services/path-recipe-service.js';
import type { SupabaseService } from '../services/supabase.js';
import type { Recipe } from '../schemas/recipe.js';

const recipe: Recipe = {
  title: 'Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs well', isSafetyStep: false }],
};
const slot = { id: 2, dishName: 'Eggs', techniqueFocus: 'Heat', isFinal: false };
const profile = { id: 'u1', experienceLevel: 'never_cooked' as const, budget: 'low' as const, equipment: ['pan'] };

describe('recipe route during a prewarm', () => {
  it('joins the in-flight generation: one model call', async () => {
    let release: (v: string) => void = () => undefined;
    const ollamaClient = {
      generate: vi.fn().mockImplementation(() => new Promise<string>((r) => { release = r; })),
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
    } as SupabaseService;
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
});
