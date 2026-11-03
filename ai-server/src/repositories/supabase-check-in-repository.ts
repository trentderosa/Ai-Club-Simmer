import type { CheckInRecord } from '../types/check-in.js';
import type { CheckInRepository, CreateCheckInParams } from './check-in-repository.js';

export interface SupabaseCheckInConfig {
  url: string;
  serviceRoleKey: string;
}

interface CheckInRow {
  id: string;
  user_id: string;
  user_recipe_id: string;
  slot_id: number;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  is_repeat: boolean;
  created_at: string;
}

/**
 * Supabase implementation of CheckInRepository.
 * Uses service-role client to bypass RLS for server-side operations.
 * Matches the check_ins table schema from PR #2.
 */
export class SupabaseCheckInRepository implements CheckInRepository {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: SupabaseCheckInConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
      'Prefer': 'return=representation',
    };
  }

  async validateUserRecipe(userId: string, userRecipeId: string, slotId: number): Promise<boolean> {
    // N7: Use separate error handling - don't conflate DB errors with "not found"
    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('select', 'id');
    url.searchParams.set('id', `eq.${userRecipeId}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('slot_id', `eq.${slotId}`);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      // DB error - throw rather than returning false
      const errorText = await response.text();
      throw new Error(`Database error validating recipe: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return Array.isArray(data) && data.length > 0;
  }

  async create(params: CreateCheckInParams): Promise<CheckInRecord> {
    const url = `${this.baseUrl}/check_ins`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        user_id: params.user_id,
        user_recipe_id: params.user_recipe_id,
        slot_id: params.slot_id,
        difficulty_rating: params.difficulty_rating,
        went_well: params.went_well,
        was_hard: params.was_hard,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create check-in: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as CheckInRow | CheckInRow[];
    const row: CheckInRow = Array.isArray(data) ? data[0] : data;

    return {
      id: row.id,
      user_id: row.user_id,
      user_recipe_id: row.user_recipe_id,
      slot_id: row.slot_id,
      difficulty_rating: row.difficulty_rating,
      went_well: row.went_well,
      was_hard: row.was_hard,
      is_repeat: row.is_repeat,
      created_at: new Date(row.created_at),
    };
  }

  async getById(id: string, userId: string): Promise<CheckInRecord | null> {
    const url = new URL(`${this.baseUrl}/check_ins`);
    url.searchParams.set('id', `eq.${id}`);
    url.searchParams.set('user_id', `eq.${userId}`);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database error fetching check-in: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as CheckInRow[];
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const row = data[0];
    return {
      id: row.id,
      user_id: row.user_id,
      user_recipe_id: row.user_recipe_id,
      slot_id: row.slot_id,
      difficulty_rating: row.difficulty_rating,
      went_well: row.went_well,
      was_hard: row.was_hard,
      is_repeat: row.is_repeat,
      created_at: new Date(row.created_at),
    };
  }

  async getRecentByUser(userId: string, limit = 5): Promise<CheckInRecord[]> {
    const url = new URL(`${this.baseUrl}/check_ins`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database error fetching check-ins: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as CheckInRow[];
    if (!Array.isArray(data)) {
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
