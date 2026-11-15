/**
 * Cook-anything config constants.
 *
 * Clamp bounds are the anti-farming limit on LLM-reported recipe size.
 * They are also seeded in xp_config (migration 20261115180000_cook_anything.sql)
 * so award_generated_recipe_xp re-clamps at insert time. Keep these in sync.
 *
 * Needs Ian/Trent OK.
 */
export const FREEFORM_COUNT_BOUNDS = {
  steps: { min: 1, max: 15 },
  ingredients: { min: 1, max: 20 },
  minutes: { min: 1, max: 120 },
} as const;

export type FreeformCountBounds = typeof FREEFORM_COUNT_BOUNDS;

/** Max length of the trimmed dish query (also enforced server-side). */
export const COOK_ANYTHING_MAX_DISH_LENGTH = 80;

/** Per-user cap on uncached cook-anything generations (Ollama + YouTube). */
export const COOK_ANYTHING_RATE_LIMIT = {
  windowMs: { default: 3_600_000, min: 1_000, max: 86_400_000 },
  maxGenerations: { default: 5, min: 1, max: 100 },
} as const;
