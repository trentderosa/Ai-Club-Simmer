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

  it('retries when the first attempt rinses raw chicken and saves the clean second attempt', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const rinsing: Recipe = {
        ...validRecipe,
        steps: [{ instruction: 'Rinse the chicken under cold water.', isSafetyStep: false }],
      };
      const clean: Recipe = {
        ...validRecipe,
        steps: [{ instruction: 'Pat the chicken dry with paper towels.', isSafetyStep: false }],
      };
      const generate = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(rinsing))
        .mockResolvedValueOnce(JSON.stringify(clean));
      const pending = generateCookAnythingRecipe({ generate }, 'Roast chicken', user);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.recipe.steps[0].instruction).toBe('Pat the chicken dry with paper towels.');
        expect(result.recipe.steps[0].isSafetyStep).toBe(true);
        expect(JSON.stringify(result.recipe)).not.toContain('Rinse the chicken under cold water');
      }
      expect(generate).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('Recipe attempt rejected', {
        reason: 'unsafe_raw_protein_rinse',
        attempt: 1,
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the flagged rinse when every cook-anything attempt still rinses', async () => {
    vi.useFakeTimers();
    try {
      const rinsing: Recipe = {
        ...validRecipe,
        steps: [{ instruction: 'Rinse the chicken under cold water.', isSafetyStep: false }],
      };
      const generate = vi.fn().mockResolvedValue(JSON.stringify(rinsing));
      const pending = generateCookAnythingRecipe({ generate }, 'Roast chicken', user);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.recipe.steps[0].instruction).toBe('Rinse the chicken under cold water.');
        expect(result.recipe.steps[0].isSafetyStep).toBe(true);
      }
      expect(generate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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

  it('drops a coachNote that says to rinse raw chicken and keeps the recipe', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ ...validRecipe, coachNote: 'Rinse the chicken first.' }));
    const result = await generateCookAnythingRecipe({ generate }, 'Pad Thai', user);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recipe.coachNote).toBeUndefined();
      expect(result.recipe.steps).toEqual(validRecipe.steps);
    }
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
