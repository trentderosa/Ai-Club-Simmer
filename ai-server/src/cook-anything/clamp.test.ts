import { describe, expect, it } from 'vitest';
import type { Recipe } from '../schemas/recipe.js';
import { FREEFORM_COUNT_BOUNDS } from './constants.js';
import { clampRecipeCounts, computeFreeformXp } from './clamp.js';

function inflatedRecipe(): Recipe {
  return {
    title: 'Inflated',
    timeEstimateMinutes: 999,
    ingredients: Array.from({ length: 80 }, (_, i) => ({
      name: `ingredient ${i + 1}`,
      amount: '1',
    })),
    steps: Array.from({ length: 50 }, (_, i) => ({
      instruction: `Step ${i + 1}: keep going.`,
      isSafetyStep: false,
    })),
  };
}

describe('FREEFORM_COUNT_BOUNDS', () => {
  it('is the explicit clamp constant: steps 1–15, ingredients 1–20, minutes 1–120', () => {
    expect(FREEFORM_COUNT_BOUNDS).toEqual({
      steps: { min: 1, max: 15 },
      ingredients: { min: 1, max: 20 },
      minutes: { min: 1, max: 120 },
    });
  });
});

describe('clampRecipeCounts', () => {
  it('clamps an inflated LLM recipe (50 steps, 80 ingredients, 999 minutes) and uses array lengths for counts', () => {
    const clamped = clampRecipeCounts(inflatedRecipe());
    expect(clamped.recipe.steps).toHaveLength(15);
    expect(clamped.recipe.ingredients).toHaveLength(20);
    expect(clamped.recipe.timeEstimateMinutes).toBe(120);
    expect(clamped.stepCount).toBe(15);
    expect(clamped.ingredientCount).toBe(20);
    expect(clamped.timeEstimateMinutes).toBe(120);
  });

  it('yields the capped XP for those clamped counts', () => {
    const clamped = clampRecipeCounts(inflatedRecipe());
    // (15*0.45 + 20*0.35 + 120*0.2)*10 = (6.75 + 7 + 24)*10 = 377.5 → 378
    expect(
      computeFreeformXp(clamped.stepCount, clamped.ingredientCount, clamped.timeEstimateMinutes)
    ).toBe(378);
  });

  it('does not invent extra steps when the recipe is already small', () => {
    const recipe: Recipe = {
      title: 'Toast',
      timeEstimateMinutes: 5,
      ingredients: [{ name: 'bread', amount: '1 slice' }],
      steps: [{ instruction: 'Toast the bread.', isSafetyStep: true }],
    };
    const clamped = clampRecipeCounts(recipe);
    expect(clamped.stepCount).toBe(1);
    expect(clamped.ingredientCount).toBe(1);
    expect(clamped.timeEstimateMinutes).toBe(5);
  });
});
