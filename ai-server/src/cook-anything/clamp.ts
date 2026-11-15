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
 * Slice the validated recipe arrays and clamp minutes. Counts used for XP
 * come from the resulting arrays, never from a separate model-reported number.
 */
export function clampRecipeCounts(
  recipe: Recipe,
  bounds: FreeformCountBounds = FREEFORM_COUNT_BOUNDS
): ClampedRecipeCounts {
  const steps = recipe.steps.slice(0, bounds.steps.max);
  const ingredients = recipe.ingredients.slice(0, bounds.ingredients.max);
  const timeEstimateMinutes = clampInt(
    recipe.timeEstimateMinutes,
    bounds.minutes.min,
    bounds.minutes.max
  );
  const stepCount = clampInt(steps.length, bounds.steps.min, bounds.steps.max);
  const ingredientCount = clampInt(
    ingredients.length,
    bounds.ingredients.min,
    bounds.ingredients.max
  );
  return {
    recipe: { ...recipe, steps, ingredients, timeEstimateMinutes },
    stepCount,
    ingredientCount,
    timeEstimateMinutes,
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
