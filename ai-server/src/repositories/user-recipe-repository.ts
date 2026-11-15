import type { Recipe } from '../schemas/recipe.js';
import type { RecipeVideos } from '../services/video-finder.js';

export interface SavedRecipe {
  id: string;
  userId: string;
  slotId: number;
  recipe: Recipe;
  /** Technique videos (F4); null until they have been looked up. */
  videos: RecipeVideos | null;
  createdAt: Date;
}

export interface UserRecipeRepository {
  findByUserAndSlot(userId: string, slotId: number): Promise<SavedRecipe | null>;
  save(userId: string, slotId: number, recipe: Recipe): Promise<SavedRecipe>;
  /** Store the technique videos for a saved recipe (user_recipes.video_ids). */
  saveVideos(userId: string, slotId: number, videos: RecipeVideos): Promise<void>;
}

export class InMemoryUserRecipeRepository implements UserRecipeRepository {
  private recipes: Map<string, SavedRecipe> = new Map();
  private locks: Map<string, Promise<SavedRecipe>> = new Map();
  private idCounter = 0;

  private makeKey(userId: string, slotId: number): string {
    return `${userId}:${slotId}`;
  }

  async findByUserAndSlot(
    userId: string,
    slotId: number
  ): Promise<SavedRecipe | null> {
    const key = this.makeKey(userId, slotId);
    
    const pending = this.locks.get(key);
    if (pending) {
      return pending;
    }
    
    return this.recipes.get(key) ?? null;
  }

  async save(userId: string, slotId: number, recipe: Recipe): Promise<SavedRecipe> {
    const key = this.makeKey(userId, slotId);

    const pending = this.locks.get(key);
    if (pending) {
      return pending;
    }

    const existing = this.recipes.get(key);
    if (existing) {
      return existing;
    }

    const savePromise = Promise.resolve().then(() => {
      const saved: SavedRecipe = {
        id: `recipe-${++this.idCounter}`,
        userId,
        slotId,
        recipe,
        videos: null,
        createdAt: new Date(),
      };
      this.recipes.set(key, saved);
      this.locks.delete(key);
      return saved;
    });

    this.locks.set(key, savePromise);
    return savePromise;
  }

  saveVideos(userId: string, slotId: number, videos: RecipeVideos): Promise<void> {
    const existing = this.recipes.get(this.makeKey(userId, slotId));
    if (existing) {
      existing.videos = videos;
    }
    return Promise.resolve();
  }

  clear(): void {
    this.recipes.clear();
    this.locks.clear();
  }

  getAll(): SavedRecipe[] {
    return Array.from(this.recipes.values());
  }
}
