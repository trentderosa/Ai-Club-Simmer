import type { CheckInRecord } from '../types/check-in.js';

export interface CreateCheckInParams {
  user_id: string;
  user_recipe_id: string;
  slot_id: number;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  /** F8 mastery challenge only (final slot): steps hidden / revealed. */
  hidden_steps?: number | null;
  revealed_steps?: number | null;
  /**
   * When set (the client's idempotency_key), used as check_ins.id.
   * A second create with the same id and the same user/recipe/slot returns
   * the existing row (first write wins). A same-id mismatch throws
   * CheckInIdempotencyConflict.
   */
  id?: string;
}

export interface CheckInRepository {
  /**
   * Create a new check-in record, or return the existing one when `id` is a
   * replay of the same check-in (see CreateCheckInParams.id).
   *
   * NOTE: The route should call validateUserRecipe() BEFORE calling create().
   * The InMemoryCheckInRepository validates ownership in create() for safety,
   * but SupabaseCheckInRepository does not (it uses service-role and bypasses RLS).
   * Do not rely on create() to enforce ownership - always validate first.
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
