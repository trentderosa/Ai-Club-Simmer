import { CheckInIdempotencyConflict } from '../types/check-in.js';
import {
  DEFAULT_SUPABASE_REST_TIMEOUT_MS,
  SupabaseRestError,
  parseJsonText,
  withSupabaseTimeout,
} from '../services/supabase-rest.js';
import type {
  CreateGeneratedCheckInParams,
  GeneratedCheckInRecord,
  GeneratedCheckInRepository,
} from './generated-check-in-repository.js';

interface Row {
  id: string;
  user_id: string;
  generated_recipe_id: string;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  is_repeat: boolean;
  created_at: string;
}

export class SupabaseGeneratedCheckInRepository implements GeneratedCheckInRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: { url: string; serviceRoleKey: string; timeoutMs?: number }) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUPABASE_REST_TIMEOUT_MS;
  }

  private async request<T>(url: string, init: RequestInit, label: string): Promise<T> {
    return withSupabaseTimeout(`generated check-in ${label}`, this.timeoutMs, async (signal) => {
      const response = await fetch(url, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw SupabaseRestError.fromResponse(`${label} failed`, response.status, text);
      }
      return text ? parseJsonText<T>(text, `${label} failed`, response.status) : (null as T);
    });
  }

  async validateRecipe(userId: string, generatedRecipeId: string): Promise<boolean> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('select', 'id');
    url.searchParams.set('id', `eq.${generatedRecipeId}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('limit', '1');
    const rows = await this.request<Array<{ id: string }>>(
      url.toString(),
      { method: 'GET' },
      'validate generated recipe'
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async getDishName(userId: string, generatedRecipeId: string): Promise<string | null> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('select', 'dish_query');
    url.searchParams.set('id', `eq.${generatedRecipeId}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('limit', '1');
    const rows = await this.request<Array<{ dish_query?: string }>>(
      url.toString(),
      { method: 'GET' },
      'select generated recipe dish'
    );
    const dish = Array.isArray(rows) ? rows[0]?.dish_query : undefined;
    return typeof dish === 'string' && dish.trim() ? dish : null;
  }

  async create(params: CreateGeneratedCheckInParams): Promise<GeneratedCheckInRecord> {
    if (params.id) {
      const existingUrl = new URL(`${this.baseUrl}/generated_recipe_check_ins`);
      existingUrl.searchParams.set('select', '*');
      existingUrl.searchParams.set('id', `eq.${params.id}`);
      existingUrl.searchParams.set('limit', '1');
      const existingRows = await this.request<Row[]>(
        existingUrl.toString(),
        { method: 'GET' },
        'select generated_recipe_check_ins'
      );
      const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
      if (existing) {
        if (
          existing.user_id === params.user_id &&
          existing.generated_recipe_id === params.generated_recipe_id
        ) {
          return { ...this.toRecord(existing), created: false };
        }
        throw new CheckInIdempotencyConflict();
      }
    }

    try {
      const rows = await this.request<Row[]>(
        `${this.baseUrl}/generated_recipe_check_ins`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(params.id ? { id: params.id } : {}),
            user_id: params.user_id,
            generated_recipe_id: params.generated_recipe_id,
            difficulty_rating: params.difficulty_rating,
            went_well: params.went_well,
            was_hard: params.was_hard,
          }),
        },
        'insert generated_recipe_check_ins'
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) throw new Error('insert generated_recipe_check_ins returned no row');
      return { ...this.toRecord(row), created: true };
    } catch (error) {
      if (error instanceof SupabaseRestError && error.status === 409 && params.id) {
        const existingUrl = new URL(`${this.baseUrl}/generated_recipe_check_ins`);
        existingUrl.searchParams.set('select', '*');
        existingUrl.searchParams.set('id', `eq.${params.id}`);
        existingUrl.searchParams.set('limit', '1');
        const existingRows = await this.request<Row[]>(
          existingUrl.toString(),
          { method: 'GET' },
          'select generated_recipe_check_ins'
        );
        const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
        if (
          existing &&
          existing.user_id === params.user_id &&
          existing.generated_recipe_id === params.generated_recipe_id
        ) {
          return { ...this.toRecord(existing), created: false };
        }
        throw new CheckInIdempotencyConflict();
      }
      throw error;
    }
  }

  private toRecord(row: Row): Omit<GeneratedCheckInRecord, 'created'> {
    return {
      id: row.id,
      user_id: row.user_id,
      generated_recipe_id: row.generated_recipe_id,
      difficulty_rating: row.difficulty_rating,
      went_well: row.went_well,
      was_hard: row.was_hard,
      is_repeat: row.is_repeat,
      created_at: new Date(row.created_at),
    };
  }
}
