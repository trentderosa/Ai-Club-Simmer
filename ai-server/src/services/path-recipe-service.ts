import { generateRecipe, type PathSlot } from './recipe-generator.js';
import type { OllamaClient } from './ollama-client.js';
import type { OllamaBudget } from './ollama-budget.js';
import type { SupabaseService } from './supabase.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import type { RecipeVideos, VideoFinder, VideoLookupResult } from './video-finder.js';

export interface PathGenerationResult {
  success: true;
  recipe: Recipe;
  videos: RecipeVideos;
}

export interface PathGenerationError {
  success: false;
  error: { type: string; message: string; attempts: number };
}

export interface PathRecipeServiceDeps {
  ollamaClient: OllamaClient;
  /** Per-request time budget for the model queue and calls. No deadline when unset. */
  generationBudget?: OllamaBudget;
  supabase: SupabaseService;
  /** F4 technique videos. Without it (no YOUTUBE_API_KEY) recipes have no videos. */
  videoFinder?: VideoFinder | null;
}

export interface PathRecipeService {
  /**
   * Generate and save a path recipe, one in flight per user and slot. A second
   * caller for the same user and slot (the route during a prewarm, or the
   * reverse) joins the running generation instead of starting another.
   */
  generate(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile
  ): Promise<PathGenerationResult | PathGenerationError>;
  attachVideos(userId: string, slotId: number, recipe: Recipe): Promise<RecipeVideos>;
}

/**
 * Shared by the recipe route and the check-in prewarmer. Create one instance
 * and pass it to both: the in-flight map lives here.
 */
export function createPathRecipeService(deps: PathRecipeServiceDeps): PathRecipeService {
  const inFlightGenerations = new Map<string, Promise<PathGenerationResult | PathGenerationError>>();

  async function generateAndSave(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile
  ): Promise<PathGenerationResult | PathGenerationError> {
    const result = await generateRecipe(deps.ollamaClient, slot, userProfile, {
      budget: deps.generationBudget,
    });

    if (!result.success) {
      return result;
    }

    const savedRecipe = await deps.supabase.saveRecipe(userId, slot.id, result.recipe);
    const videos = await attachVideos(userId, slot.id, savedRecipe);
    return { success: true, recipe: savedRecipe, videos };
  }

  /**
   * F4: look up technique videos and store them with the recipe. Never fails
   * the request: on any error the recipe is returned with whatever videos
   * were found.
   *
   * Videos are stored only when the lookup is complete (every technique got a
   * video or a genuine "no result"). If any search failed, timed out or was
   * skipped, nothing is stored, so `video_ids` stays null and the lookup runs
   * again on the next visit. Searches that did succeed are in the shared
   * technique cache, so the retry only re-runs the missing ones.
   */
  async function attachVideos(userId: string, slotId: number, recipe: Recipe): Promise<RecipeVideos> {
    if (!deps.videoFinder) return {};
    let lookup: VideoLookupResult;
    try {
      lookup = await deps.videoFinder.findForRecipe(recipe);
    } catch (error) {
      console.warn('recipe_videos_failed', {
        slot_id: slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
    if (!lookup.complete) {
      console.warn('recipe_videos_incomplete', { slot_id: slotId, found: Object.keys(lookup.videos).length });
      return lookup.videos;
    }
    try {
      await deps.supabase.saveVideos(userId, slotId, lookup.videos);
    } catch (error) {
      console.warn('recipe_videos_save_failed', {
        slot_id: slotId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return lookup.videos;
  }

  async function generate(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile
  ): Promise<PathGenerationResult | PathGenerationError> {
    const key = `${userId}:${slot.id}`;

    const inFlight = inFlightGenerations.get(key);
    if (inFlight) {
      return inFlight;
    }

    const generationPromise = generateAndSave(userId, slot, userProfile);
    inFlightGenerations.set(key, generationPromise);

    try {
      return await generationPromise;
    } finally {
      inFlightGenerations.delete(key);
    }
  }

  return { generate, attachVideos };
}
