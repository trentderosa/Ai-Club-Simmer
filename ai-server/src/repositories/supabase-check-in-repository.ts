import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckInRecord } from '../types/check-in.js';
import type { CheckInRepository, CreateCheckInParams } from './check-in-repository.js';

/**
 * Supabase implementation of CheckInRepository.
 * Uses service-role client to bypass RLS for server-side operations.
 * Matches the check_ins table schema from PR #2.
 */
export class SupabaseCheckInRepository implements CheckInRepository {
  constructor(private supabase: SupabaseClient) {}

  async validateUserRecipe(userId: string, userRecipeId: string, slotId: number): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('user_recipes')
      .select('id')
      .eq('id', userRecipeId)
      .eq('user_id', userId)
      .eq('slot_id', slotId)
      .single();

    if (error || !data) {
      return false;
    }
    return true;
  }

  async create(params: CreateCheckInParams): Promise<CheckInRecord> {
    const isValid = await this.validateUserRecipe(params.user_id, params.user_recipe_id, params.slot_id);
    if (!isValid) {
      throw new Error('Invalid user_recipe_id or slot_id mismatch');
    }

    const { data, error } = await this.supabase
      .from('check_ins')
      .insert({
        user_id: params.user_id,
        user_recipe_id: params.user_recipe_id,
        slot_id: params.slot_id,
        difficulty_rating: params.difficulty_rating,
        went_well: params.went_well,
        was_hard: params.was_hard,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create check-in: ${error.message}`);
    }

    return {
      id: data.id,
      user_id: data.user_id,
      user_recipe_id: data.user_recipe_id,
      slot_id: data.slot_id,
      difficulty_rating: data.difficulty_rating,
      went_well: data.went_well,
      was_hard: data.was_hard,
      is_repeat: data.is_repeat,
      created_at: new Date(data.created_at),
    };
  }

  async getById(id: string, userId: string): Promise<CheckInRecord | null> {
    const { data, error } = await this.supabase
      .from('check_ins')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      user_id: data.user_id,
      user_recipe_id: data.user_recipe_id,
      slot_id: data.slot_id,
      difficulty_rating: data.difficulty_rating,
      went_well: data.went_well,
      was_hard: data.was_hard,
      is_repeat: data.is_repeat,
      created_at: new Date(data.created_at),
    };
  }

  async getRecentByUser(userId: string, limit = 5): Promise<CheckInRecord[]> {
    const { data, error } = await this.supabase
      .from('check_ins')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      return [];
    }

    return data.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      user_recipe_id: row.user_recipe_id,
      slot_id: row.slot_id,
      difficulty_rating: row.difficulty_rating,
      went_well: row.went_well,
      was_hard: row.was_hard,
      is_repeat: row.is_repeat,
      created_at: new Date(row.created_at),
    }));
  }
}
