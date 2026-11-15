import type { Recipe } from '../schemas/recipe.js';
import type { RecipeVideos } from '../services/video-finder.js';

export interface SavedGeneratedRecipe {
  id: string;
  userId: string;
  dishQuery: string;
  normalizedDishName: string;
  recipe: Recipe;
  videos: RecipeVideos | null;
  stepCount: number;
  ingredientCount: number;
  timeEstimateMinutes: number;
  xpValue: number;
  createdAt: Date;
}

export interface SaveGeneratedRecipeInput {
  userId: string;
  dishQuery: string;
  normalizedDishName: string;
  recipe: Recipe;
  stepCount: number;
  ingredientCount: number;
  timeEstimateMinutes: number;
  /** First-cook XP from the clamped counts; the DB trigger also stamps this. */
  xpValue: number;
}

export interface GeneratedRecipeRepository {
  findByUserAndNormalizedName(
    userId: string,
    normalizedDishName: string
  ): Promise<SavedGeneratedRecipe | null>;
  findByIdForUser(userId: string, id: string): Promise<SavedGeneratedRecipe | null>;
  /**
   * Insert if this user has no recipe for the normalized name yet.
   * On a conflict, returns the existing row (counts and xp_value stay frozen).
   */
  save(input: SaveGeneratedRecipeInput): Promise<SavedGeneratedRecipe>;
  saveVideos(userId: string, id: string, videos: RecipeVideos): Promise<void>;
}
