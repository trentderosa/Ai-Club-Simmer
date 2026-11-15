import type { Recipe } from '../schemas/recipe.js';
import { FREEFORM_COUNT_BOUNDS, type FreeformCountBounds } from './constants.js';

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export interface ClampedRecipeCounts {
  recipe: Recipe;
  stepCount: number;
  ingredientCount: number;
  timeEstimateMinutes: number;
}

/**
 * Clamp only the counts used for XP. The validated recipe is stored unchanged
 * so later steps (including safety steps) and the real cook time are not cut.
 */
export function clampRecipeCounts(
  recipe: Recipe,
  bounds: FreeformCountBounds = FREEFORM_COUNT_BOUNDS
): ClampedRecipeCounts {
  return {
    recipe,
    stepCount: clampInt(recipe.steps.length, bounds.steps.min, bounds.steps.max),
    ingredientCount: clampInt(
      recipe.ingredients.length,
      bounds.ingredients.min,
      bounds.ingredients.max
    ),
    timeEstimateMinutes: clampInt(
      recipe.timeEstimateMinutes,
      bounds.minutes.min,
      bounds.minutes.max
    ),
  };
}

/**
 * Same integer math as PostgreSQL ROUND(numeric) for non-negative values
 * (half away from zero) and as recompute_slot_xp / award_generated_recipe_xp.
 */
export function computeFreeformXp(
  stepCount: number,
  ingredientCount: number,
  timeEstimateMinutes: number,
  weights: {
    stepsWeight: number;
    ingredientsWeight: number;
    cookMinutesWeight: number;
    multiplier: number;
  } = {
    stepsWeight: 0.45,
    ingredientsWeight: 0.35,
    cookMinutesWeight: 0.2,
    multiplier: 10,
  }
): number {
  const raw =
    (stepCount * weights.stepsWeight +
      ingredientCount * weights.ingredientsWeight +
      timeEstimateMinutes * weights.cookMinutesWeight) *
    weights.multiplier;
  return Math.max(1, Math.round(raw));
}
