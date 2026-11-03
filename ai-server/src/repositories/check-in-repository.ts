import type { CheckInRecord } from '../types/check-in.js';

export interface CreateCheckInParams {
  user_id: string;
  user_recipe_id: string;
  slot_id: number;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
}

export interface CheckInRepository {
  /**
   * Create a new check-in record.
   * Validates that user_recipe_id belongs to the user and slot_id matches.
   */
  create(params: CreateCheckInParams): Promise<CheckInRecord>;

  /**
   * Get a check-in by ID.
   */
  getById(id: string, userId: string): Promise<CheckInRecord | null>;

  /**
   * Get recent check-ins for a user (for Coach's note context).
   */
  getRecentByUser(userId: string, limit?: number): Promise<CheckInRecord[]>;

  /**
   * Verify that a user_recipe belongs to the user and matches the slot.
   */
  validateUserRecipe(userId: string, userRecipeId: string, slotId: number): Promise<boolean>;
}
