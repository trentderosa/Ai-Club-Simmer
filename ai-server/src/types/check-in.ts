import { z } from 'zod';

const MasterySchema = z
  .object({
    hidden_steps: z.number().int().min(0).max(30),
    revealed_steps: z.number().int().min(0).max(30),
  })
  .refine((m) => m.revealed_steps <= m.hidden_steps, {
    message: 'revealed_steps cannot be more than hidden_steps',
    path: ['revealed_steps'],
  });

/**
 * Path check-in (slot 1-10) or a cook-anything check-in (generated_recipe_id).
 * Exactly one of those two shapes is allowed. Idempotency key is reused on
 * retry for both, stored as the check-in row's primary key.
 */
export const CheckInInputSchema = z
  .object({
    user_recipe_id: z.string().uuid().optional(),
    slot_id: z.number().int().min(1).max(10).optional(),
    generated_recipe_id: z.string().uuid().optional(),
    rating: z.enum(['easy', 'ok', 'hard']),
    went_well: z.string().max(500).optional(),
    was_hard: z.string().max(500).optional(),
    /**
     * F8 mastery challenge (final slot only): the server-side session from
     * POST /api/mastery/sessions. The check-in's hidden/revealed counts are
     * read from that session, never from the client.
     */
    mastery_session_id: z.string().uuid().optional(),
    /**
     * Deprecated: client-reported reveal counts from before mastery sessions.
     * Still accepted so older clients do not get a 400, but ignored: without
     * a mastery_session_id the check-in earns no mastery badge.
     */
    mastery: MasterySchema.optional(),
    /**
     * Client-generated UUID, unique for one check-in attempt. Reused on retry
     * so a timed-out POST cannot insert a second row or award XP twice.
     * Stored as the check-in row's id. First write wins. Optional so older
     * clients keep working.
     */
    idempotency_key: z.string().uuid().optional(),
  })
  .superRefine((val, ctx) => {
    const hasPath = val.user_recipe_id !== undefined && val.slot_id !== undefined;
    const hasGenerated = val.generated_recipe_id !== undefined;
    const partialPath =
      (val.user_recipe_id !== undefined) !== (val.slot_id !== undefined);
    if (hasPath && hasGenerated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either a path slot or a cook-anything recipe, not both',
      });
    } else if (partialPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'user_recipe_id and slot_id are both required for a path check-in',
      });
    } else if (!hasPath && !hasGenerated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide user_recipe_id and slot_id, or generated_recipe_id',
      });
    }
    if (hasGenerated && val.mastery !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mastery'],
        message: 'mastery is only allowed for the path mastery challenge',
      });
    }
    if (hasGenerated && val.mastery_session_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mastery_session_id'],
        message: 'mastery_session_id is only allowed for the path mastery challenge',
      });
    }
  });

export type CheckInInput = z.infer<typeof CheckInInputSchema>;

export type PathCheckInInput = CheckInInput & {
  user_recipe_id: string;
  slot_id: number;
};

export type GeneratedCheckInInput = CheckInInput & {
  generated_recipe_id: string;
};

export function isGeneratedCheckIn(input: CheckInInput): input is GeneratedCheckInInput {
  return input.generated_recipe_id !== undefined;
}

export function isPathCheckIn(input: CheckInInput): input is PathCheckInInput {
  return input.user_recipe_id !== undefined && input.slot_id !== undefined;
}

export interface CheckInRecord {
  id: string;
  user_id: string;
  user_recipe_id: string;
  slot_id: number;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  is_repeat: boolean;
  created_at: Date;
}

export const CoachNoteSchema = z.object({
  note: z.string().min(1).max(500),
  focus_area: z.string().max(40).optional(),
});

export type CoachNote = z.infer<typeof CoachNoteSchema>;

/**
 * XP outcome for a check-in.
 * - awarded: award_slot_xp ran (xp_awarded may be 0 when the weekly repeat cap is hit)
 * - failed: the award call errored; the check-in is still saved and the error is logged
 * - skipped: no XP awarder is configured (dev in-memory mode only)
 */
/** A badge this check-in earned (F9); empty for repeats. */
export interface CheckInBadge {
  code: string;
  name: string;
  description: string;
  kind: 'completion' | 'mastery' | 'path_milestone';
}

/**
 * Badges outcome for a check-in.
 * - ok: `earned` lists badges this check-in earned (show the celebration)
 * - failed: the lookup errored; the check-in is saved and badges still show
 *   on the badges screen (they are derived from check-ins)
 * - skipped: no badge lookup configured (dev in-memory mode only)
 */
export type CheckInBadges =
  | { status: 'ok'; earned: CheckInBadge[] }
  | { status: 'failed' }
  | { status: 'skipped' };

export type CheckInXp =
  | { status: 'awarded'; xp_awarded: number; is_first_completion: boolean; capped: boolean }
  | { status: 'failed' }
  | { status: 'skipped' };

export interface CheckInResponse {
  check_in_id: string;
  coach_note: string;
  focus_area?: string;
  xp: CheckInXp;
  badges: CheckInBadges;
  /**
   * F6: true when the user rated the session "hard". The app suggests cooking
   * this recipe again before moving on; the user can accept or skip. The path
   * never changes either way.
   */
  suggest_repeat: boolean;
}

/**
 * The given idempotency_key already belongs to a different user, recipe, or slot.
 * The route maps this to 409 IDEMPOTENCY_CONFLICT.
 */
/**
 * The mastery session can't back this check-in: it was already used by
 * another check-in (MASTERY_SESSION_USED, 409) or belongs to a different
 * user, slot or recipe (INVALID_MASTERY_SESSION, 400).
 */
export class CheckInMasterySessionError extends Error {
  constructor(readonly code: 'MASTERY_SESSION_USED' | 'INVALID_MASTERY_SESSION') {
    super(
      code === 'MASTERY_SESSION_USED'
        ? 'This mastery session was already used for a check-in'
        : 'mastery_session_id does not match this check-in'
    );
    this.name = 'CheckInMasterySessionError';
  }
}

export class CheckInIdempotencyConflict extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  constructor() {
    super('idempotency_key was already used for a different check-in');
    this.name = 'CheckInIdempotencyConflict';
  }
}
