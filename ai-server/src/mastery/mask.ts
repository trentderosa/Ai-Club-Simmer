import type { Recipe } from '../schemas/recipe.js';

/**
 * F8 mastery challenge: the final path slot is cooked with every non-safety
 * step hidden. The ai-server never sends a hidden step's text except through
 * POST /api/mastery/sessions/:id/reveal, which records the reveal first.
 *
 * Must match mastery_hidden_step_indices() in
 * supabase/migrations/20261116000000_mastery_sessions.sql.
 */

export const HIDDEN_STEP_INSTRUCTION = 'Hidden step. Reveal it in cook mode if you need a reminder.';

/**
 * Minimum number of hideable (non-safety) steps the slot 10 recipe must have
 * after safety flagging, so the mastery badge can't be earned by cooking a
 * recipe with nothing hidden. MASTERY RULE: Ian owns mastery rules and may
 * change this number (pending his OK). Also used in the slot 10 prompt.
 */
export const MASTERY_MIN_HIDDEN_STEPS = 3;
/** Minimum total steps asked for in the slot 10 prompt (a hint, not enforced). */
export const MASTERY_MIN_STEPS = 6;

export type MaskedStep = Recipe['steps'][number] & { isHidden?: true };
export type MaskedRecipe = Omit<Recipe, 'steps'> & { steps: MaskedStep[] };

export function hiddenStepIndices(recipe: Pick<Recipe, 'steps'>): number[] {
  return recipe.steps.flatMap((step, i) => (step.isSafetyStep ? [] : [i]));
}

/**
 * Replace each hidden step's instruction and "why it matters" with a
 * placeholder and mark it `isHidden: true`. Safety steps stay as they are.
 * The technique name stays, so its video can still be shown ahead of time.
 */
export function maskRecipeForMastery(recipe: Recipe): MaskedRecipe {
  return {
    ...recipe,
    steps: recipe.steps.map((step): MaskedStep => {
      if (step.isSafetyStep) return step;
      const masked: MaskedStep = { instruction: HIDDEN_STEP_INSTRUCTION, isSafetyStep: false, isHidden: true };
      if (step.techniqueName) masked.techniqueName = step.techniqueName;
      return masked;
    }),
  };
}
