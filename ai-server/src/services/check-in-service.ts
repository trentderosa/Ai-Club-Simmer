import type { CheckInRepository } from '../repositories/check-in-repository.js';
import type { CheckInBadges, CheckInInput, CheckInResponse, CheckInXp } from '../types/check-in.js';
import type { PathRepository } from '../repositories/path-repository.js';
import type { CoachNoteGenerator } from './coach-note.js';
import { xpAwardErrorReason, type XpAwarder } from './xp-awarder.js';

export interface CheckInLogger {
  error(message: string, context: Record<string, unknown>): void;
}

export interface CheckInServiceOptions {
  /**
   * Slot lookups (mastery validation) and badge lookups (F9). Without it
   * (dev in-memory mode) badges are reported as skipped.
   */
  pathRepository?: Pick<PathRepository, 'getPathSlot' | 'badgesEarnedBy'> | null;
}

export class CheckInService {
  private pathRepository: CheckInServiceOptions['pathRepository'];

  constructor(
    private repository: CheckInRepository,
    private coachNoteGenerator: CoachNoteGenerator,
    private xpAwarder: XpAwarder | null = null,
    private logger: CheckInLogger = console,
    options: CheckInServiceOptions = {}
  ) {
    this.pathRepository = options.pathRepository ?? null;
  }

  /**
   * Process a post-cook check-in:
   * 1. Validate ownership (done in route before calling this)
   * 2. Persist raw text to repository (N2: store raw, sanitize only for prompt)
   * 3. Award XP server-side via award_slot_xp (service role). A failed award
   *    (including a timeout, XP_AWARD_TIMEOUT_MS) is logged with a reason and
   *    reported as xp.status = 'failed'; the check-in stays saved, and
   *    `npm run reconcile:xp` re-runs the award later.
   * 4. Look up badges this check-in earned (F9). A failed lookup is logged
   *    and reported as badges.status = 'failed'; badges are derived from
   *    check-ins, so they still appear on the badges screen.
   * 5. Generate Coach's note via Ollama
   * 6. suggest_repeat = rated "hard" (F6). The path never changes.
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
      hidden_steps: input.mastery?.hidden_steps ?? null,
      revealed_steps: input.mastery?.revealed_steps ?? null,
    });

    const xp = await this.awardXp(checkIn.id, checkIn.slot_id);
    const badges = await this.lookUpBadges(checkIn.id, checkIn.slot_id);

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
      badges,
      suggest_repeat: input.rating === 'hard',
    };
  }

  /**
   * F8: mastery reveal counts are only allowed on the final slot. Returns
   * false when they are sent for any other slot. Without a path repository
   * (dev) the database trigger is the only check.
   */
  async isMasteryInputAllowed(input: CheckInInput): Promise<boolean> {
    if (!input.mastery || !this.pathRepository) return true;
    const slot = await this.pathRepository.getPathSlot(input.slot_id);
    return slot?.isFinal === true;
  }

  private async lookUpBadges(checkInId: string, slotId: number): Promise<CheckInBadges> {
    if (!this.pathRepository) {
      return { status: 'skipped' };
    }
    try {
      const earned = await this.pathRepository.badgesEarnedBy(checkInId);
      return { status: 'ok', earned };
    } catch (error) {
      this.logger.error('badge_lookup_failed', {
        check_in_id: checkInId,
        slot_id: slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed' };
    }
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
