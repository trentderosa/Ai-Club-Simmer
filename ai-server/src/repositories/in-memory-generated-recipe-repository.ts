import { randomUUID } from 'crypto';
import type { DishPhoto } from '../services/dish-photo.js';
import type { RecipeVideos } from '../services/video-finder.js';
import type {
  GeneratedRecipeRepository,
  SaveGeneratedRecipeInput,
  SavedGeneratedRecipe,
} from './generated-recipe-repository.js';

export class InMemoryGeneratedRecipeRepository implements GeneratedRecipeRepository {
  private readonly byId = new Map<string, SavedGeneratedRecipe>();
  private readonly byKey = new Map<string, string>();
  private readonly locks = new Map<string, Promise<SavedGeneratedRecipe>>();

  private key(userId: string, normalizedDishName: string): string {
    return `${userId}:${normalizedDishName}`;
  }

  findByUserAndNormalizedName(
    userId: string,
    normalizedDishName: string
  ): Promise<SavedGeneratedRecipe | null> {
    const key = this.key(userId, normalizedDishName);
    const pending = this.locks.get(key);
    if (pending) return pending;
    const id = this.byKey.get(key);
    return Promise.resolve(id ? (this.byId.get(id) ?? null) : null);
  }

  findByIdForUser(userId: string, id: string): Promise<SavedGeneratedRecipe | null> {
    const saved = this.byId.get(id);
    return Promise.resolve(saved && saved.userId === userId ? saved : null);
  }

  save(input: SaveGeneratedRecipeInput): Promise<SavedGeneratedRecipe> {
    const key = this.key(input.userId, input.normalizedDishName);
    const pending = this.locks.get(key);
    if (pending) return pending;

    const existingId = this.byKey.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return Promise.resolve(existing);
    }

    const savePromise = Promise.resolve().then(() => {
      const saved: SavedGeneratedRecipe = {
        id: randomUUID(),
        userId: input.userId,
        dishQuery: input.dishQuery,
        normalizedDishName: input.normalizedDishName,
        recipe: input.recipe,
        videos: null,
        photo: null,
        stepCount: input.stepCount,
        ingredientCount: input.ingredientCount,
        timeEstimateMinutes: input.timeEstimateMinutes,
        xpValue: input.xpValue,
        createdAt: new Date(),
      };
      this.byId.set(saved.id, saved);
      this.byKey.set(key, saved.id);
      this.locks.delete(key);
      return saved;
    });
    this.locks.set(key, savePromise);
    return savePromise;
  }

  saveVideos(userId: string, id: string, videos: RecipeVideos): Promise<void> {
    const saved = this.byId.get(id);
    if (saved && saved.userId === userId) {
      saved.videos = videos;
    }
    return Promise.resolve();
  }

  savePhoto(userId: string, id: string, photo: DishPhoto): Promise<void> {
    const saved = this.byId.get(id);
    if (saved && saved.userId === userId) {
      saved.photo = photo;
    }
    return Promise.resolve();
  }
}
