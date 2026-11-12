import type { CheckInRepository } from '../repositories/check-in-repository.js';
import type { CheckInInput, CheckInResponse, CheckInXp } from '../types/check-in.js';
import type { CoachNoteGenerator } from './coach-note.js';
import { xpAwardErrorReason, type XpAwarder } from './xp-awarder.js';

export interface CheckInLogger {
  error(message: string, context: Record<string, unknown>): void;
}

export class CheckInService {
  constructor(
    private repository: CheckInRepository,
    private coachNoteGenerator: CoachNoteGenerator,
    private xpAwarder: XpAwarder | null = null,
    private logger: CheckInLogger = console
  ) {}

  /**
   * Process a post-cook check-in:
   * 1. Validate ownership (done in route before calling this)
   * 2. Persist raw text to repository (N2: store raw, sanitize only for prompt)
   * 3. Award XP server-side via award_slot_xp (service role). A failed award
   *    (including a timeout, XP_AWARD_TIMEOUT_MS) is logged with a reason and
   *    reported as xp.status = 'failed'; the check-in stays saved, and
   *    `npm run reconcile:xp` re-runs the award later.
   * 4. Generate Coach's note via Ollama
   */
  async processCheckIn(
    userId: string,
    input: CheckInInput
  ): Promise<CheckInResponse> {
    const checkIn = await this.repository.create({
      user_id: userId,
      user_recipe_id: input.user_recipe_id,
      slot_id: input.slot_id,
      difficulty_rating: input.rating,
      went_well: input.went_well ?? null,
      was_hard: input.was_hard ?? null,
    });

    const xp = await this.awardXp(checkIn.id, checkIn.slot_id);

    const coachNote = await this.coachNoteGenerator.generate(
      input.rating,
      input.went_well ?? null,
      input.was_hard ?? null
    );

    return {
      check_in_id: checkIn.id,
      coach_note: coachNote.note,
      focus_area: coachNote.focus_area,
      xp,
    };
  }

  private async awardXp(checkInId: string, slotId: number): Promise<CheckInXp> {
    if (!this.xpAwarder) {
      return { status: 'skipped' };
    }
    try {
      const result = await this.xpAwarder.award(checkInId);
      return {
        status: 'awarded',
        xp_awarded: result.xp_awarded,
        is_first_completion: result.is_first_completion,
        capped: result.capped,
      };
    } catch (error) {
      // Never rethrow: the check-in is already saved and must not be lost.
      this.logger.error('xp_award_failed', {
        check_in_id: checkInId,
        slot_id: slotId,
        reason: xpAwardErrorReason(error),
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed' };
    }
  }

  /**
   * Validate that a user_recipe belongs to the user and matches the slot.
   */
  async validateUserRecipe(
    userId: string,
    userRecipeId: string,
    slotId: number
  ): Promise<boolean> {
    return this.repository.validateUserRecipe(userId, userRecipeId, slotId);
  }
}
