import type { Recipe } from '../schemas/recipe.js';

export interface SavedRecipe {
  id: string;
  userId: string;
  slotId: number;
  recipe: Recipe;
  createdAt: Date;
}

export interface UserRecipeRepository {
  findByUserAndSlot(userId: string, slotId: number): Promise<SavedRecipe | null>;
  save(userId: string, slotId: number, recipe: Recipe): Promise<SavedRecipe>;
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
        createdAt: new Date(),
      };
      this.recipes.set(key, saved);
      this.locks.delete(key);
      return saved;
    });

    this.locks.set(key, savePromise);
    return savePromise;
  }

  clear(): void {
    this.recipes.clear();
    this.locks.clear();
  }

  getAll(): SavedRecipe[] {
    return Array.from(this.recipes.values());
  }
}
