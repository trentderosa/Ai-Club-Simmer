import type { CheckInRepository } from '../repositories/check-in-repository.js';
import type { GeneratedCheckInRepository } from '../repositories/generated-check-in-repository.js';
import type { CheckInBadges, CheckInInput, CheckInResponse, CheckInXp, CoachNote } from '../types/check-in.js';
import { isGeneratedCheckIn, isPathCheckIn } from '../types/check-in.js';
import type { PathRepository } from '../repositories/path-repository.js';
import type { CoachNoteContext, CoachNoteGenerator } from './coach-note.js';
import { xpAwardErrorReason, type XpAwarder } from './xp-awarder.js';

export interface CheckInLogger {
  error(message: string, context: Record<string, unknown>): void;
}

export interface CheckInServiceOptions {
  /**
   * Slot lookups (mastery validation) and badge lookups (F9). Without it
   * (dev in-memory mode) badges are reported as skipped.
   */
  pathRepository?: (Pick<PathRepository, 'getPathSlot' | 'badgesEarnedBy'> &
    Partial<Pick<PathRepository, 'getEquipment'>>) | null;
  /** Cook-anything check-ins. Without it, generated_recipe_id check-ins fail validation. */
  generatedCheckInRepository?: GeneratedCheckInRepository | null;
  /** Awards XP for cook-anything check-ins via award_generated_recipe_xp. */
  generatedXpAwarder?: XpAwarder | null;
}

/** Returned on an idempotent replay so a retry does not call Ollama again. */
export const REPLAY_COACH_NOTE: CoachNote = {
  note: 'Your check-in was already saved.',
};

export class CheckInService {
  private pathRepository: CheckInServiceOptions['pathRepository'];
  private generatedCheckInRepository: GeneratedCheckInRepository | null;
  private generatedXpAwarder: XpAwarder | null;

  constructor(
    private repository: CheckInRepository,
    private coachNoteGenerator: CoachNoteGenerator,
    private xpAwarder: XpAwarder | null = null,
    private logger: CheckInLogger = console,
    options: CheckInServiceOptions = {}
  ) {
    this.pathRepository = options.pathRepository ?? null;
    this.generatedCheckInRepository = options.generatedCheckInRepository ?? null;
    this.generatedXpAwarder = options.generatedXpAwarder ?? null;
  }

  /**
   * Process a post-cook check-in:
   * 1. Validate ownership (done in route before calling this)
   * 2. Persist raw text to repository (N2: store raw, sanitize only for prompt).
   *    When input.idempotency_key is set, it becomes check_ins.id so a retry
   *    of the same attempt returns the existing row instead of inserting another.
   * 3. Award XP server-side (service role): award_slot_xp for a path slot,
   *    award_generated_recipe_xp for Cook anything. A failed award (including
   *    a timeout, XP_AWARD_TIMEOUT_MS) is logged with a reason and reported
   *    as xp.status = 'failed'; the check-in stays saved, and
   *    `npm run reconcile:xp` re-runs the matching award later.
   * 4. Look up badges this check-in earned (F9). A failed lookup is logged
   *    and reported as badges.status = 'failed'; badges are derived from
   *    check-ins, so they still appear on the badges screen.
   * 5. Generate Coach's note via Ollama. On an idempotent replay
   *    (`create()` returned created: false), skip generation and return
   *    REPLAY_COACH_NOTE so a retry cannot start a second Ollama run.
   * 6. suggest_repeat = rated "hard" (F6). The path never changes.
   */
  async processCheckIn(
    userId: string,
    input: CheckInInput
  ): Promise<CheckInResponse> {
    if (isGeneratedCheckIn(input)) {
      return this.processGeneratedCheckIn(userId, input);
    }
    if (!isPathCheckIn(input)) {
      throw new Error('Invalid check-in input');
    }

    const checkIn = await this.repository.create({
      id: input.idempotency_key,
      user_id: userId,
      user_recipe_id: input.user_recipe_id,
      slot_id: input.slot_id,
      difficulty_rating: input.rating,
      went_well: input.went_well ?? null,
      was_hard: input.was_hard ?? null,
      mastery_session_id: input.mastery_session_id ?? null,
    });

    const xp = await this.awardXp(this.xpAwarder, checkIn.id, checkIn.slot_id);
    const badges = await this.lookUpBadges(checkIn.id, checkIn.slot_id);

    const coachNote = checkIn.created
      ? await this.coachNoteGenerator.generate(
          input.rating,
          input.went_well ?? null,
          input.was_hard ?? null,
          await this.coachNoteContext(userId, () =>
            this.pathRepository ? this.pathRepository.getPathSlot(checkIn.slot_id) : Promise.resolve(null)
          )
        )
      : REPLAY_COACH_NOTE;

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
   * Dish name and equipment for the coach note. Best effort: a failed lookup
   * is logged and the note is generated without it (never fails a check-in).
   */
  private async coachNoteContext(
    userId: string,
    lookUpDish: () => Promise<{ dishName: string } | string | null | undefined>
  ): Promise<CoachNoteContext> {
    const context: CoachNoteContext = {};
    const [dish, equipment] = await Promise.all([
      lookUpDish().catch((error: unknown) => this.logLookupFailure('coach_note_dish_lookup_failed', error)),
      this.pathRepository?.getEquipment
        ? this.pathRepository.getEquipment(userId).catch((error: unknown) =>
            this.logLookupFailure('coach_note_equipment_lookup_failed', error)
          )
        : Promise.resolve(null),
    ]);
    const dishName = typeof dish === 'string' ? dish : dish?.dishName;
    if (dishName) context.dishName = dishName;
    if (equipment && equipment.length > 0) context.equipment = equipment;
    return context;
  }

  private logLookupFailure(message: string, error: unknown): null {
    this.logger.error(message, { error: error instanceof Error ? error.message : String(error) });
    return null;
  }

  /**
   * F8: a mastery session (or the deprecated client counts) is only allowed
   * on the final slot. Returns false when sent for any other slot. Without a
   * path repository (dev) the database trigger is the only check.
   */
  async isMasteryInputAllowed(input: CheckInInput): Promise<boolean> {
    if ((!input.mastery && !input.mastery_session_id) || !this.pathRepository) return true;
    if (input.slot_id === undefined) return false;
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

  private async processGeneratedCheckIn(
    userId: string,
    input: CheckInInput & { generated_recipe_id: string }
  ): Promise<CheckInResponse> {
    if (!this.generatedCheckInRepository) {
      throw new Error('Cook-anything check-ins are not configured');
    }
    const checkIn = await this.generatedCheckInRepository.create({
      id: input.idempotency_key,
      user_id: userId,
      generated_recipe_id: input.generated_recipe_id,
      difficulty_rating: input.rating,
      went_well: input.went_well ?? null,
      was_hard: input.was_hard ?? null,
    });

    const xp = await this.awardXp(this.generatedXpAwarder, checkIn.id, 0);
    const badges: CheckInBadges = { status: 'skipped' };

    const coachNote = checkIn.created
      ? await this.coachNoteGenerator.generate(
          input.rating,
          input.went_well ?? null,
          input.was_hard ?? null,
          await this.coachNoteContext(userId, () =>
            this.generatedCheckInRepository?.getDishName
              ? this.generatedCheckInRepository.getDishName(userId, input.generated_recipe_id)
              : Promise.resolve(null)
          )
        )
      : REPLAY_COACH_NOTE;

    return {
      check_in_id: checkIn.id,
      coach_note: coachNote.note,
      focus_area: coachNote.focus_area,
      xp,
      badges,
      suggest_repeat: input.rating === 'hard',
    };
  }

  private async awardXp(awarder: XpAwarder | null, checkInId: string, slotId: number): Promise<CheckInXp> {
    if (!awarder) {
      return { status: 'skipped' };
    }
    try {
      const result = await awarder.award(checkInId);
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

  async validateGeneratedRecipe(userId: string, generatedRecipeId: string): Promise<boolean> {
    if (!this.generatedCheckInRepository) return false;
    return this.generatedCheckInRepository.validateRecipe(userId, generatedRecipeId);
  }
}
