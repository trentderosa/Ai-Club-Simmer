import type { CheckInRepository } from '../repositories/check-in-repository.js';
import type { CheckInInput, CheckInResponse } from '../types/check-in.js';
import { generateCoachNote } from './ollama-service.js';
import { sanitizeUserText } from '../utils/sanitize.js';

export class CheckInService {
  constructor(private repository: CheckInRepository) {}

  /**
   * Process a post-cook check-in:
   * 1. Validate and sanitize input
   * 2. Persist to repository
   * 3. Generate Coach's note via Ollama
   * 4. Return response (does NOT award XP - that's handled by award_slot_xp)
   */
  async processCheckIn(
    userId: string,
    input: CheckInInput
  ): Promise<CheckInResponse> {
    const sanitizedWentWell = sanitizeUserText(input.went_well);
    const sanitizedWasHard = sanitizeUserText(input.was_hard);

    const checkIn = await this.repository.create({
      user_id: userId,
      user_recipe_id: input.user_recipe_id,
      slot_id: input.slot_id,
      difficulty_rating: input.rating,
      went_well: sanitizedWentWell,
      was_hard: sanitizedWasHard,
    });

    const coachNote = await generateCoachNote(
      input.rating,
      sanitizedWentWell,
      sanitizedWasHard
    );

    return {
      check_in_id: checkIn.id,
      coach_note: coachNote.note,
      focus_area: coachNote.focus_area,
    };
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
