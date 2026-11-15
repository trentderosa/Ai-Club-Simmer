import { z } from 'zod';

export const CheckInInputSchema = z
  .object({
    user_recipe_id: z.string().uuid(),
    slot_id: z.number().int().min(1).max(10),
    rating: z.enum(['easy', 'ok', 'hard']),
    went_well: z.string().max(500).optional(),
    was_hard: z.string().max(500).optional(),
    /**
     * F8 mastery challenge (final slot only): how many steps started hidden
     * and how many the user revealed ("Revealed X of Y hidden steps").
     */
    mastery: z
      .object({
        hidden_steps: z.number().int().min(0).max(30),
        revealed_steps: z.number().int().min(0).max(30),
      })
      .refine((m) => m.revealed_steps <= m.hidden_steps, {
        message: 'revealed_steps cannot be more than hidden_steps',
        path: ['revealed_steps'],
      })
      .optional(),
    /**
     * Client-generated UUID, unique for one check-in attempt. Reused on retry
     * so a timed-out POST cannot insert a second row or award XP twice.
     * Stored as check_ins.id (the existing primary key); no migration needed.
     * First write wins. Optional so older clients keep working.
     */
    idempotency_key: z.string().uuid().optional(),
  });

export type CheckInInput = z.infer<typeof CheckInInputSchema>;

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
export class CheckInIdempotencyConflict extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  constructor() {
    super('idempotency_key was already used for a different check-in');
    this.name = 'CheckInIdempotencyConflict';
  }
}
