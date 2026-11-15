import { describe, expect, it } from 'vitest';
import type { Recipe } from '../schemas/recipe.js';
import { FREEFORM_COUNT_BOUNDS } from './constants.js';
import { clampRecipeCounts, computeFreeformXp } from './clamp.js';

/** Max xp_value implied by FREEFORM_COUNT_BOUNDS and the slot formula. */
const MAX_FREEFORM_XP = computeFreeformXp(
  FREEFORM_COUNT_BOUNDS.steps.max,
  FREEFORM_COUNT_BOUNDS.ingredients.max,
  FREEFORM_COUNT_BOUNDS.minutes.max
);

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
  it('is the explicit clamp constant: steps 1–10, ingredients 1–12, minutes 1–45', () => {
    expect(FREEFORM_COUNT_BOUNDS).toEqual({
      steps: { min: 1, max: 10 },
      ingredients: { min: 1, max: 12 },
      minutes: { min: 1, max: 45 },
    });
  });
});

describe('clampRecipeCounts', () => {
  it('clamps XP counts for an inflated LLM recipe and leaves the stored recipe intact', () => {
    const recipe = inflatedRecipe();
    const clamped = clampRecipeCounts(recipe);
    expect(clamped.recipe).toBe(recipe);
    expect(clamped.recipe.steps).toHaveLength(50);
    expect(clamped.recipe.ingredients).toHaveLength(80);
    expect(clamped.recipe.timeEstimateMinutes).toBe(999);
    expect(clamped.stepCount).toBe(FREEFORM_COUNT_BOUNDS.steps.max);
    expect(clamped.ingredientCount).toBe(FREEFORM_COUNT_BOUNDS.ingredients.max);
    expect(clamped.timeEstimateMinutes).toBe(FREEFORM_COUNT_BOUNDS.minutes.max);
  });

  it('yields the capped XP for those clamped counts', () => {
    // (10*0.45 + 12*0.35 + 45*0.2)*10 = 177, below roast chicken (181)
    expect(MAX_FREEFORM_XP).toBe(177);
    const clamped = clampRecipeCounts(inflatedRecipe());
    expect(
      computeFreeformXp(clamped.stepCount, clamped.ingredientCount, clamped.timeEstimateMinutes)
    ).toBe(MAX_FREEFORM_XP);
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
