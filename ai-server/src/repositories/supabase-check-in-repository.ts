import { CheckInIdempotencyConflict, CheckInMasterySessionError, type CheckInRecord } from '../types/check-in.js';
import type { CheckInRepository, CreateCheckInParams, CreatedCheckIn } from './check-in-repository.js';
import { DEFAULT_SUPABASE_REST_TIMEOUT_MS, SupabaseRestError, readJson, withSupabaseTimeout } from '../services/supabase-rest.js';

export interface SupabaseCheckInConfig {
  url: string;
  serviceRoleKey: string;
  /** Abort each request (including reading its body) after this many ms (default 5000, like SupabaseRest). */
  timeoutMs?: number;
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
  private readonly timeoutMs: number;

  constructor(config: SupabaseCheckInConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
      'Prefer': 'return=representation',
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUPABASE_REST_TIMEOUT_MS;
  }

  async validateUserRecipe(userId: string, userRecipeId: string, slotId: number): Promise<boolean> {
    // N7: Use separate error handling - don't conflate DB errors with "not found"
    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('select', 'id');
    url.searchParams.set('id', `eq.${userRecipeId}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('slot_id', `eq.${slotId}`);

    const data = await withSupabaseTimeout('check-in read', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        // DB error - throw rather than returning false
        const errorText = await response.text();
        throw SupabaseRestError.fromResponse('Database error validating recipe', response.status, errorText);
      }

      return readJson<unknown>(response, 'Supabase check-in read');
    });
    return Array.isArray(data) && data.length > 0;
  }

  async create(params: CreateCheckInParams): Promise<CreatedCheckIn> {
    const url = `${this.baseUrl}/check_ins`;

    const outcome = await withSupabaseTimeout('check-in create', this.timeoutMs, async (signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          ...(params.id ? { id: params.id } : {}),
          user_id: params.user_id,
          user_recipe_id: params.user_recipe_id,
          slot_id: params.slot_id,
          difficulty_rating: params.difficulty_rating,
          went_well: params.went_well,
          was_hard: params.was_hard,
          // Only when set, so ordinary check-ins don't depend on the column existing.
          ...(params.mastery_session_id ? { mastery_session_id: params.mastery_session_id } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        return { ok: false as const, status: response.status, errorText: await response.text() };
      }
      const data = await readJson<CheckInRow | CheckInRow[]>(response, 'Supabase check-in read');
      return { ok: true as const, data };
    });

    if (!outcome.ok) {
      const { status, errorText } = outcome;
      if (status === 409) {
        if (params.id) {
          // A replay of the same attempt conflicts on the id (and on the session).
          const replay = await this.resolveIdempotentConflict(params, !!params.mastery_session_id);
          if (replay) return replay;
        }
        if (params.mastery_session_id && /mastery_session_id/.test(errorText)) {
          throw new CheckInMasterySessionError('MASTERY_SESSION_USED');
        }
        throw SupabaseRestError.fromResponse('Failed to create check-in', status, errorText);
      }

      if (params.mastery_session_id && /mastery session does not match/.test(errorText)) {
        throw new CheckInMasterySessionError('INVALID_MASTERY_SESSION');
      }
      throw SupabaseRestError.fromResponse('Failed to create check-in', status, errorText);
    }

    const data = outcome.data;
    const row: CheckInRow = Array.isArray(data) ? data[0] : data;
    return { ...this.toRecord(row), created: true };
  }

  /**
   * A 409 on a client-supplied id means the row already exists. Return it when
   * it is the same user's same recipe/slot; otherwise reject the replay.
   */
  private async resolveIdempotentConflict(params: CreateCheckInParams, allowMissing: boolean): Promise<CreatedCheckIn | null> {
    const existing = await this.getByIdAny(params.id!);
    if (!existing) {
      // The conflict was on something else (a used mastery session).
      if (allowMissing) return null;
      throw new Error(`Conflict but no existing check-in found for id ${params.id}`);
    }
    if (
      existing.user_id === params.user_id &&
      existing.user_recipe_id === params.user_recipe_id &&
      existing.slot_id === params.slot_id
    ) {
      return { ...existing, created: false };
    }
    throw new CheckInIdempotencyConflict();
  }

  private async getByIdAny(id: string): Promise<CheckInRecord | null> {
    const url = new URL(`${this.baseUrl}/check_ins`);
    url.searchParams.set('id', `eq.${id}`);

    const data = await withSupabaseTimeout('check-in read', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw SupabaseRestError.fromResponse('Database error fetching check-in', response.status, errorText);
      }

      return readJson<CheckInRow[]>(response, 'Supabase check-in read');
    });
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }
    return this.toRecord(data[0]);
  }

  private toRecord(row: CheckInRow): CheckInRecord {
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

    const data = await withSupabaseTimeout('check-in read', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw SupabaseRestError.fromResponse('Database error fetching check-in', response.status, errorText);
      }

      return readJson<CheckInRow[]>(response, 'Supabase check-in read');
    });
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return this.toRecord(data[0]);
  }

  async getRecentByUser(userId: string, limit = 5): Promise<CheckInRecord[]> {
    const url = new URL(`${this.baseUrl}/check_ins`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', String(limit));

    const data = await withSupabaseTimeout('check-in read', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw SupabaseRestError.fromResponse('Database error fetching check-ins', response.status, errorText);
      }

      return readJson<CheckInRow[]>(response, 'Supabase check-in read');
    });
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((row) => this.toRecord(row));
  }
}
