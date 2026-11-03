import type { Recipe } from '../schemas/recipe.js';
import type { UserRecipeRepository, SavedRecipe } from './user-recipe-repository.js';

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

interface SupabaseUserRecipeRow {
  id: string;
  user_id: string;
  slot_id: number;
  recipe_json: Recipe;
  created_at: string;
}

export class SupabaseUserRecipeRepository implements UserRecipeRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private inFlightSaves: Map<string, Promise<SavedRecipe>> = new Map();

  constructor(config: SupabaseConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
  }

  private makeKey(userId: string, slotId: number): string {
    return `${userId}:${slotId}`;
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

    const url = new URL(`${this.baseUrl}/user_recipes`);
    url.searchParams.set('user_id', `eq.${userId}`);
    url.searchParams.set('slot_id', `eq.${slotId}`);
    url.searchParams.set('select', '*');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase query failed: ${response.status} ${error}`);
    }

    const rows = (await response.json()) as SupabaseUserRecipeRow[];
    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      slotId: row.slot_id,
      recipe: row.recipe_json,
      createdAt: new Date(row.created_at),
    };
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
    const url = `${this.baseUrl}/user_recipes`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Prefer': 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        slot_id: slotId,
        recipe_json: recipe,
      }),
    });

    if (response.status === 409) {
      const existing = await this.findByUserAndSlot(userId, slotId);
      if (existing) {
        return existing;
      }
      throw new Error('Conflict but no existing record found');
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase insert failed: ${response.status} ${error}`);
    }

    const rows = (await response.json()) as SupabaseUserRecipeRow[];
    if (rows.length === 0) {
      throw new Error('Insert returned no rows');
    }

    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      slotId: row.slot_id,
      recipe: row.recipe_json,
      createdAt: new Date(row.created_at),
    };
  }
}
