/**
 * Cook-anything config constants.
 *
 * Clamp bounds are the anti-farming limit on LLM-reported recipe size.
 * They are also seeded in xp_config (migration 20261115180000_cook_anything.sql)
 * so the insert trigger re-clamps at write time. Keep these in sync.
 *
 * Trent: steps 1–10, ingredients 1–12, minutes 1–45. Max xp_value is 177,
 * below roast chicken (181). Daily cap stays at 200.
 */
export const FREEFORM_COUNT_BOUNDS = {
  steps: { min: 1, max: 10 },
  ingredients: { min: 1, max: 12 },
  minutes: { min: 1, max: 45 },
} as const;

export type FreeformCountBounds = typeof FREEFORM_COUNT_BOUNDS;

/** Max length of the trimmed dish query (also enforced server-side). */
export const COOK_ANYTHING_MAX_DISH_LENGTH = 80;

/**
 * Per-user cap on uncached cook-anything generations (Ollama + YouTube).
 * try_cook_anything_generation rejects windows and caps outside these bounds.
 */
export const COOK_ANYTHING_RATE_LIMIT = {
  windowMs: { default: 3_600_000, min: 1_000, max: 86_400_000 },
  maxGenerations: { default: 5, min: 1, max: 100 },
} as const;
