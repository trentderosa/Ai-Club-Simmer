/**
 * Zod schemas for everything the app reads from the backend.
 *
 * Source of truth: docs/CLIENT_API.md, the `get_my_plan` / `get_my_plan_summary`
 * SQL in supabase/migrations, and ai-server/src/schemas/recipe.ts +
 * ai-server/src/types/check-in.ts. Responses are parsed at the API boundary so
 * screens only ever see these types.
 */
import { z } from 'zod';

// ---------- Supabase: profiles (F1) ----------

export const EXPERIENCE_LEVELS = ['never_cooked', 'a_little', 'comfortable'] as const;
export const BUDGETS = ['low', 'medium', 'high'] as const;

/** Columns the app writes on `profiles`. Diet isn't in the schema yet. */
export const ProfileInputSchema = z.object({
  goals: z.string().max(500),
  experience_level: z.enum(EXPERIENCE_LEVELS),
  equipment: z.array(z.string().min(1)).min(1),
  budget: z.enum(BUDGETS),
  days_per_week: z.number().int().min(1).max(7),
  minutes_per_session: z.number().int().positive(),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const ProfileSchema = z.object({
  id: z.string(),
  goals: z.string().nullable(),
  experience_level: z.enum(EXPERIENCE_LEVELS).nullable(),
  equipment: z.array(z.string()).nullable(),
  budget: z.enum(BUDGETS).nullable(),
  days_per_week: z.number().int().nullable(),
  minutes_per_session: z.number().int().nullable(),
  onboarding_completed: z.boolean().nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

// ---------- Supabase: plan RPCs (F2, F7) ----------

export const SlotStatusSchema = z.enum(['done', 'current', 'locked']);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const PlanSlotSchema = z.object({
  slot_id: z.number().int(),
  slot_order: z.number().int(),
  dish_name: z.string(),
  technique_focus: z.string(),
  xp_value: z.number().int(),
  is_final: z.boolean(),
  status: SlotStatusSchema,
  has_recipe: z.boolean(),
  times_completed: z.number().int(),
  first_completed_at: z.string().nullable(),
});
export type PlanSlot = z.infer<typeof PlanSlotSchema>;

export const PlanSchema = z.array(PlanSlotSchema);

export const PlanSummarySchema = z.object({
  total_xp: z.number().int(),
  completed_slots: z.number().int(),
  total_slots: z.number().int(),
  /** null once every slot is done. */
  current_slot_order: z.number().int().nullable(),
  path_complete: z.boolean(),
  days_per_week: z.number().int().nullable(),
  minutes_per_session: z.number().int().nullable(),
  /** null until the onboarding schedule is set. */
  suggested_sessions_per_week: z.number().int().nullable(),
  estimated_weeks_remaining: z.number().int().nullable(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

/** The RPC returns a one-row table; supabase-js gives it to us as an array. */
export const PlanSummaryRowsSchema = z.array(PlanSummarySchema).min(1);

// ---------- AI server: recipe (F3, F4, F5) ----------

export const RecipeStepSchema = z.object({
  instruction: z.string().min(1),
  whyItMatters: z.string().optional(),
  isSafetyStep: z.boolean(),
  techniqueName: z.string().optional(),
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const IngredientSchema = z.object({ name: z.string().min(1), amount: z.string().min(1) });
export type Ingredient = z.infer<typeof IngredientSchema>;

export const RecipeSchema = z.object({
  title: z.string().min(1),
  ingredients: z.array(IngredientSchema).min(1),
  timeEstimateMinutes: z.number().int().positive(),
  steps: z.array(RecipeStepSchema).min(1),
  coachNote: z.string().optional(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const VideoSchema = z.object({
  videoId: z.string().min(1),
  title: z.string(),
  channelTitle: z.string().optional(),
  /** Official YouTube URL when the server validated it. */
  url: z.string().optional(),
});
export type Video = z.infer<typeof VideoSchema>;

/**
 * techniqueName -> video. Can be partial or empty (no YouTube key, or some
 * searches failed). `null` (as stored in `user_recipes.video_ids`) means {}.
 */
export const VideosSchema = z
  .record(z.string(), VideoSchema)
  .nullish()
  .transform((v) => v ?? {});
export type Videos = Record<string, Video>;

export const RecipeResponseSchema = z.object({
  recipe: RecipeSchema,
  cached: z.boolean(),
  videos: VideosSchema,
});
export type RecipeResponse = z.infer<typeof RecipeResponseSchema>;

export const CookAnythingCountsSchema = z.object({
  steps: z.number().int().min(1),
  ingredients: z.number().int().min(1),
  minutes: z.number().int().min(1),
});

export const CookAnythingResponseSchema = z.object({
  generated_recipe_id: z.string(),
  dish_query: z.string(),
  normalized_dish_name: z.string(),
  recipe: RecipeSchema,
  cached: z.boolean(),
  videos: VideosSchema,
  xp_value: z.number().int().min(1),
  counts: CookAnythingCountsSchema,
});
export type CookAnythingResponse = z.infer<typeof CookAnythingResponseSchema>;

// ---------- AI server: check-in (F6, F7, F9) ----------

export const RATINGS = ['easy', 'ok', 'hard'] as const;
export type Rating = (typeof RATINGS)[number];

export const CheckInInputSchema = z
  .object({
    user_recipe_id: z.string().uuid().optional(),
    slot_id: z.number().int().min(1).max(10).optional(),
    generated_recipe_id: z.string().uuid().optional(),
    rating: z.enum(RATINGS),
    went_well: z.string().max(500).optional(),
    was_hard: z.string().max(500).optional(),
    /** Client-generated UUID, unique per check-in attempt; reused on retry. */
    idempotency_key: z.string().uuid().optional(),
  })
  .superRefine((val, ctx) => {
    const path = val.user_recipe_id !== undefined && val.slot_id !== undefined;
    const gen = val.generated_recipe_id !== undefined;
    if (path === gen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either a path slot or a cook-anything recipe, not both',
      });
    }
  });
export type CheckInInput = z.infer<typeof CheckInInputSchema>;

export const CheckInXpSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('awarded'),
    xp_awarded: z.number().int().min(0),
    is_first_completion: z.boolean(),
    capped: z.boolean(),
  }),
  z.object({ status: z.literal('failed') }),
  z.object({ status: z.literal('skipped') }),
]);
export type CheckInXp = z.infer<typeof CheckInXpSchema>;

export const CheckInBadgeSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['completion', 'mastery', 'path_milestone']),
});
export type CheckInBadge = z.infer<typeof CheckInBadgeSchema>;

export const CheckInBadgesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), earned: z.array(CheckInBadgeSchema) }),
  z.object({ status: z.literal('failed') }),
  z.object({ status: z.literal('skipped') }),
]);
export type CheckInBadges = z.infer<typeof CheckInBadgesSchema>;

export const CheckInResponseSchema = z.object({
  check_in_id: z.string(),
  coach_note: z.string(),
  focus_area: z.string().optional(),
  xp: CheckInXpSchema,
  badges: CheckInBadgesSchema,
  suggest_repeat: z.boolean(),
});
export type CheckInResponse = z.infer<typeof CheckInResponseSchema>;

/** Error body shape used by the ai-server (`code` is set on some 400/403s). */
export const ApiErrorBodySchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});
