import { z } from 'zod';
import { FreeformRecipeSchema } from '../cook-anything/recipe-schema.js';
import {
  DEFAULT_SUPABASE_REST_TIMEOUT_MS,
  SupabaseRestError,
} from '../services/supabase-rest.js';
import type { DishPhoto } from '../services/dish-photo.js';
import { isAllowedCommonsFileUrl, isAllowedImageUrl } from '../services/dish-photo.js';
import type { RecipeVideos } from '../services/video-finder.js';
import type {
  GeneratedRecipeRepository,
  SaveGeneratedRecipeInput,
  SavedGeneratedRecipe,
} from './generated-recipe-repository.js';

const RecipeVideosSchema = z.record(
  z.string(),
  z.object({
    videoId: z.string(),
    title: z.string().optional(),
    channelTitle: z.string().optional(),
    url: z.string().optional(),
  })
);

const DishPhotoSchema = z.object({
  url: z.string(),
  credit: z.object({
    author: z.string(),
    license: z.string(),
    licenseUrl: z.string(),
    sourceUrl: z.string(),
  }),
});

function parseStoredPhoto(raw: unknown): DishPhoto | null {
  if (raw == null) return null;
  const parsed = DishPhotoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const photo = parsed.data;
  if (!isAllowedImageUrl(photo.url) || !isAllowedCommonsFileUrl(photo.credit.sourceUrl)) {
    return null;
  }
  return photo;
}

interface Row {
  id: string;
  user_id: string;
  dish_query: string;
  normalized_dish_name: string;
  recipe_json: unknown;
  video_ids?: unknown;
  photo_json?: unknown;
  step_count: number;
  ingredient_count: number;
  time_estimate_minutes: number;
  xp_value: number;
  created_at: string;
}

export interface SupabaseGeneratedRecipeRepoConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs?: number;
}

export class SupabaseGeneratedRecipeRepository implements GeneratedRecipeRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<SavedGeneratedRecipe>>();

  constructor(config: SupabaseGeneratedRecipeRepoConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUPABASE_REST_TIMEOUT_MS;
  }

  private key(userId: string, name: string): string {
    return `${userId}:${name}`;
  }

  private parse(row: Row): SavedGeneratedRecipe {
    const recipe = FreeformRecipeSchema.safeParse(row.recipe_json);
    if (!recipe.success) {
      throw new Error(`Invalid generated recipe data from database: ${recipe.error.message}`);
    }
    const videos = row.video_ids == null ? null : RecipeVideosSchema.safeParse(row.video_ids);
    return {
      id: row.id,
      userId: row.user_id,
      dishQuery: row.dish_query,
      normalizedDishName: row.normalized_dish_name,
      recipe: recipe.data,
      videos: videos && videos.success ? videos.data : row.video_ids == null ? null : {},
      photo: parseStoredPhoto(row.photo_json),
      stepCount: row.step_count,
      ingredientCount: row.ingredient_count,
      timeEstimateMinutes: row.time_estimate_minutes,
      xpValue: row.xp_value,
      createdAt: new Date(row.created_at),
    };
  }

  private async request<T>(url: string, init: RequestInit, label: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) }, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new SupabaseRestError(`${label} failed: ${response.status} ${text}`, response.status);
      }
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async findByUserAndNormalizedName(
    userId: string,
    normalizedDishName: string
  ): Promise<SavedGeneratedRecipe | null> {
    const pending = this.inFlight.get(this.key(userId, normalizedDishName));
    if (pending) return pending;
    return this.selectByUserAndNormalizedName(userId, normalizedDishName);
  }

  // Plain GET that never consults inFlight, so save() can call it without awaiting itself.
  private async selectByUserAndNormalizedName(
    userId: string,
    normalizedDishName: string
  ): Promise<SavedGeneratedRecipe | null> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('select', '*');
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('normalized_dish_name', `eq.${normalizedDishName}`);
    url.searchParams.set('limit', '1');
    const rows = await this.request<Row[]>(url.toString(), { method: 'GET' }, 'select user_generated_recipes');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? this.parse(row) : null;
  }

  async findByIdForUser(userId: string, id: string): Promise<SavedGeneratedRecipe | null> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('select', '*');
    url.searchParams.set('id', `eq.${id}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('limit', '1');
    const rows = await this.request<Row[]>(url.toString(), { method: 'GET' }, 'select user_generated_recipes');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? this.parse(row) : null;
  }

  async save(input: SaveGeneratedRecipeInput): Promise<SavedGeneratedRecipe> {
    const key = this.key(input.userId, input.normalizedDishName);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const savePromise = (async (): Promise<SavedGeneratedRecipe> => {
      try {
        const existing = await this.selectByUserAndNormalizedName(input.userId, input.normalizedDishName);
        if (existing) return existing;
        const url = `${this.baseUrl}/user_generated_recipes`;
        const rows = await this.request<Row[]>(
          url,
          {
            method: 'POST',
            body: JSON.stringify({
              user_id: input.userId,
              dish_query: input.dishQuery,
              normalized_dish_name: input.normalizedDishName,
              recipe_json: input.recipe,
              step_count: input.stepCount,
              ingredient_count: input.ingredientCount,
              time_estimate_minutes: input.timeEstimateMinutes,
              xp_value: input.xpValue,
            }),
          },
          'insert user_generated_recipes'
        );
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) throw new Error('insert user_generated_recipes returned no row');
        return this.parse(row);
      } catch (error) {
        // Unique conflict: another request won the insert. Return that row.
        if (error instanceof SupabaseRestError && error.status === 409) {
          const existing = await this.selectByUserAndNormalizedName(input.userId, input.normalizedDishName);
          if (existing) return existing;
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, savePromise);
    return savePromise;
  }

  async saveVideos(userId: string, id: string, videos: RecipeVideos): Promise<void> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('id', `eq.${id}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    await this.request<unknown>(
      url.toString(),
      {
        method: 'PATCH',
        body: JSON.stringify({ video_ids: videos }),
        headers: { Prefer: 'return=minimal' },
      },
      'update user_generated_recipes.video_ids'
    );
  }

  async savePhoto(userId: string, id: string, photo: DishPhoto): Promise<void> {
    const url = new URL(`${this.baseUrl}/user_generated_recipes`);
    url.searchParams.set('id', `eq.${id}`);
    url.searchParams.set('user_id', `eq.${userId}`);
    await this.request<unknown>(
      url.toString(),
      {
        method: 'PATCH',
        body: JSON.stringify({ photo_json: photo }),
        headers: { Prefer: 'return=minimal' },
      },
      'update user_generated_recipes.photo_json'
    );
  }
}

