import { randomUUID } from 'crypto';
import type { CheckInRecord } from '../types/check-in.js';
import type { CheckInRepository, CreateCheckInParams } from './check-in-repository.js';

interface UserRecipeRecord {
  id: string;
  user_id: string;
  slot_id: number;
}

/**
 * In-memory implementation of CheckInRepository for testing.
 * Does NOT persist data; all data is lost when the instance is garbage collected.
 */
export class InMemoryCheckInRepository implements CheckInRepository {
  private checkIns: Map<string, CheckInRecord> = new Map();
  private userRecipes: Map<string, UserRecipeRecord> = new Map();

  /**
   * Seed a user recipe for testing.
   */
  seedUserRecipe(userRecipe: UserRecipeRecord): void {
    this.userRecipes.set(userRecipe.id, userRecipe);
  }

  /**
   * Clear all data (useful for test isolation).
   */
  clear(): void {
    this.checkIns.clear();
    this.userRecipes.clear();
  }

  async validateUserRecipe(userId: string, userRecipeId: string, slotId: number): Promise<boolean> {
    const recipe = this.userRecipes.get(userRecipeId);
    if (!recipe) {
      return false;
    }
    return recipe.user_id === userId && recipe.slot_id === slotId;
  }

  async create(params: CreateCheckInParams): Promise<CheckInRecord> {
    const isValid = await this.validateUserRecipe(params.user_id, params.user_recipe_id, params.slot_id);
    if (!isValid) {
      throw new Error('Invalid user_recipe_id or slot_id mismatch');
    }

    const record: CheckInRecord = {
      id: randomUUID(),
      user_id: params.user_id,
      user_recipe_id: params.user_recipe_id,
      slot_id: params.slot_id,
      difficulty_rating: params.difficulty_rating,
      went_well: params.went_well,
      was_hard: params.was_hard,
      is_repeat: false,
      created_at: new Date(),
    };

    this.checkIns.set(record.id, record);
    return record;
  }

  async getById(id: string, userId: string): Promise<CheckInRecord | null> {
    const record = this.checkIns.get(id);
    if (!record || record.user_id !== userId) {
      return null;
    }
    return record;
  }

  async getRecentByUser(userId: string, limit = 5): Promise<CheckInRecord[]> {
    const userCheckIns = Array.from(this.checkIns.values())
      .filter((c) => c.user_id === userId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit);
    return userCheckIns;
  }

  /**
   * Get all check-ins (for testing assertions).
   */
  getAllCheckIns(): CheckInRecord[] {
    return Array.from(this.checkIns.values());
  }
}
