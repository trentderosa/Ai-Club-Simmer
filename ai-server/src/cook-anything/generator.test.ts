import { describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import { RecipeSchema } from '../schemas/recipe.js';
import { generateCookAnythingRecipe } from './generator.js';

const user: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'a_little',
  budget: 'low',
  equipment: ['stove', 'pan', 'pot'],
};

const validRecipe: Recipe = {
  title: 'Pad Thai',
  timeEstimateMinutes: 25,
  ingredients: [{ name: 'rice noodles', amount: '8 oz' }],
  steps: [{ instruction: 'Soak the noodles.', isSafetyStep: false }],
};

describe('generateCookAnythingRecipe', () => {
  it('validates LLM output against RecipeSchema and returns the recipe', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(validRecipe));
    const result = await generateCookAnythingRecipe({ generate }, 'Pad Thai', user);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(RecipeSchema.safeParse(result.recipe).success).toBe(true);
      expect(result.recipe.title).toBe('Pad Thai');
    }
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid output and retries, then fails without returning a half-valid recipe', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ title: 'Nope' }))
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce(JSON.stringify({ title: 'Still no' }));
    const result = await generateCookAnythingRecipe({ generate }, 'Pad Thai', user);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.attempts).toBe(3);
      expect(result.error.type).toMatch(/validation_failed|generation_failed/);
    }
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('cleans model quirks before returning (title prefix, ingredient spaces, technique labels)', async () => {
    const dirty: Recipe = {
      ...validRecipe,
      title: 'Simmer: Pad Thai',
      ingredients: [{ name: ' rice noodles', amount: '8 oz ' }],
      steps: [{ instruction: 'Soak the noodles.', isSafetyStep: false, techniqueName: 'techniqueName: soakNoodles' }],
    };
    const generate = vi.fn().mockResolvedValue(JSON.stringify(dirty));
    const result = await generateCookAnythingRecipe({ generate }, 'Pad Thai', user);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recipe.title).toBe('Pad Thai');
      expect(result.recipe.ingredients[0]).toEqual({ name: 'rice noodles', amount: '8 oz' });
      expect(result.recipe.steps[0].techniqueName).toBe('soak noodles');
    }
  });
});
