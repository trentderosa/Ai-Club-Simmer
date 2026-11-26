import type { Recipe } from '../schemas/recipe.js';
import { RecipeSchema } from '../schemas/recipe.js';
import type { UserRecipeRepository, SavedRecipe } from './user-recipe-repository.js';
import { z } from 'zod';
import type { RecipeVideos } from '../services/video-finder.js';
import { DEFAULT_SUPABASE_REST_TIMEOUT_MS, SupabaseRestError, readJson, withSupabaseTimeout } from '../services/supabase-rest.js';

const RecipeVideosSchema = z.record(
  z.string(),
  z.object({
    videoId: z.string(),
    title: z.string().optional(),
    channelTitle: z.string().optional(),
  })
);

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  /** Abort each request after this many ms (default 5000, like SupabaseRest). */
  timeoutMs?: number;
}

interface SupabaseUserRecipeRow {
  id: string;
  user_id: string;
  slot_id: number;
  recipe_json: unknown;
  video_ids?: unknown;
  created_at: string;
}

export class SupabaseUserRecipeRepository implements UserRecipeRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private inFlightSaves: Map<string, Promise<SavedRecipe>> = new Map();

  constructor(config: SupabaseConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUPABASE_REST_TIMEOUT_MS;
  }

  private makeKey(userId: string, slotId: number): string {
    return `${userId}:${slotId}`;
  }

  private parseRecipe(row: SupabaseUserRecipeRow): SavedRecipe {
    const parseResult = RecipeSchema.safeParse(row.recipe_json);
    if (!parseResult.success) {
      throw new Error(
        `Invalid recipe data from database: ${parseResult.error.message}`
      );
    }
    return {
      id: row.id,
      userId: row.user_id,
      slotId: row.slot_id,
      recipe: parseResult.data,
      videos: parseVideos(row.video_ids),
      createdAt: new Date(row.created_at),
    };
  }

  async findByUserAndSlot(
    userId: string,
    slotId: number
  ): Promise<SavedRecipe | null> {
    const key = this.makeKey(userId, slotId);

    const pending = this.inFlightSaves.get(key);
    if (pending) {
      return pending;
    }

    return this.fetchRecipe(userId, slotId);
  }

  private async fetchRecipe(
    userId: string,
    slotId: number
  ): Promise<SavedRecipe | null> {
    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('slot_id', `eq.${slotId}`);
    url.searchParams.set('select', '*');

    const rows = await withSupabaseTimeout('recipe query', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw SupabaseRestError.fromResponse('Supabase query failed', response.status, error);
      }

      return readJson<SupabaseUserRecipeRow[]>(response, 'Supabase user recipe read');
    });
    if (rows.length === 0) {
      return null;
    }

    return this.parseRecipe(rows[0]);
  }

  async saveVideos(userId: string, slotId: number, videos: RecipeVideos): Promise<void> {
    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('slot_id', `eq.${slotId}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        method: 'PATCH',
        headers: { ...this.headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ video_ids: videos }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw SupabaseRestError.fromResponse('Supabase video update failed', response.status, error);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Supabase video update timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async save(userId: string, slotId: number, recipe: Recipe): Promise<SavedRecipe> {
    const key = this.makeKey(userId, slotId);

    const pending = this.inFlightSaves.get(key);
    if (pending) {
      return pending;
    }

    const savePromise = this.doSave(userId, slotId, recipe);
    this.inFlightSaves.set(key, savePromise);

    try {
      return await savePromise;
    } finally {
      this.inFlightSaves.delete(key);
    }
  }

  private async doSave(
    userId: string,
    slotId: number,
    recipe: Recipe
  ): Promise<SavedRecipe> {
    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('on_conflict', 'user_id,slot_id');

    const outcome = await withSupabaseTimeout('recipe insert', this.timeoutMs, async (signal) => {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          ...this.headers,
          'Prefer': 'return=representation,resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          user_id: userId,
          slot_id: slotId,
          recipe_json: recipe,
        }),
        signal,
      });

      if (response.status === 409) {
        return { kind: 'conflict' as const };
      }

      if (!response.ok) {
        const error = await response.text();
        throw SupabaseRestError.fromResponse('Supabase insert failed', response.status, error);
      }

      const rows = await readJson<SupabaseUserRecipeRow[]>(response, 'Supabase user recipe read');
      return { kind: 'rows' as const, rows };
    });

    if (outcome.kind === 'conflict') {
      const existing = await this.fetchRecipe(userId, slotId);
      if (existing) {
        return existing;
      }
      throw new Error('Conflict but no existing record found');
    }

    const rows = outcome.rows;

    if (rows.length === 0) {
      const existing = await this.fetchRecipe(userId, slotId);
      if (existing) {
        return existing;
      }
      throw new Error('Insert returned no rows and no existing record found');
    }

    return this.parseRecipe(rows[0]);
  }
}

/** Stored video_ids that don't parse are treated as "not looked up yet". */
function parseVideos(raw: unknown): RecipeVideos | null {
  if (raw === null || raw === undefined) return null;
  const parsed = RecipeVideosSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
