import { z } from 'zod';
import { RecipeSchema } from '../schemas/recipe.js';

/**
 * Accept a validated free-form recipe that may be larger than the XP clamp
 * bounds (and than the path-slot RecipeSchema maxima). Counts are clamped
 * separately; the recipe body is stored as-is.
 */
export const FreeformRecipeSchema = RecipeSchema.extend({
  ingredients: RecipeSchema.shape.ingredients.element.array().min(1).max(200),
  steps: RecipeSchema.shape.steps.element.array().min(1).max(200),
  timeEstimateMinutes: z.number().int().positive().max(10_000),
});
