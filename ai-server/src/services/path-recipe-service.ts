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
  error: { type: string; message: string; attempts: number; retrySkipped?: boolean };
}

/** Optional limits for a background generation. The route passes none. */
export interface PathGenerationOptions {
  /** Asked before each retry; false stops retrying. */
  shouldRetry?: () => boolean;
  /** Never wait in the model queue; busy answers at once. */
  immediateOnly?: boolean;
}

export interface PathRecipeServiceLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export interface PathRecipeServiceDeps {
  ollamaClient: OllamaClient;
  /** Per-request time budget for the model queue and calls. No deadline when unset. */
  generationBudget?: OllamaBudget;
  supabase: SupabaseService;
  /** F4 technique videos. Without it (no YOUTUBE_API_KEY) recipes have no videos. */
  videoFinder?: VideoFinder | null;
  /** Warning sink. Defaults to the console, like the dish photo and video finders. */
  logger?: PathRecipeServiceLogger;
  /** Test hooks only. Production leaves this unset (no-ops). */
  hooks?: {
    /** Called after a joiner removes an ended entry, before it checks for or starts a rerun. */
    beforeRerun?: () => void;
  };
}

export interface PathRecipeService {
  /**
   * Generate and save a path recipe, one in flight per user and slot. A second
   * caller for the same user and slot (the route during a prewarm, or the
   * reverse) joins the running generation instead of starting another. A
   * joiner shares the running generation's options, not its own.
   */
  generate(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile,
    generationOptions?: PathGenerationOptions
  ): Promise<PathGenerationResult | PathGenerationError>;
  attachVideos(userId: string, slotId: number, recipe: Recipe): Promise<RecipeVideos>;
}

/**
 * Shared by the recipe route and the check-in prewarmer. Create one instance
 * and pass it to both: the in-flight map lives here.
 */
export function createPathRecipeService(deps: PathRecipeServiceDeps): PathRecipeService {
  const logger = deps.logger ?? console;
  // background: started with immediateOnly (a prewarm). Its failures can come
  // from those limits, so a foreground joiner may rerun instead of inheriting them.
  const inFlightGenerations = new Map<
    string,
    { promise: Promise<PathGenerationResult | PathGenerationError>; background: boolean }
  >();

  /**
   * Why a joiner of an ended generation should run its own, or null to share
   * the result. Preempted always reruns. Busy and retrySkipped rerun only when
   * the joined generation was a background one (its own limits caused them).
   * A model failure (validation, generation) is never rerun.
   */
  function joinerRerunReason(
    result: PathGenerationResult | PathGenerationError,
    background: boolean
  ): string | null {
    if (result.success) return null;
    if (result.error.type === 'preempted') return 'preempted';
    if (background && result.error.type === 'busy') return 'busy';
    if (background && result.error.retrySkipped) return 'retry_skipped';
    return null;
  }

  const normalizeNeed = (need: string): string => need.trim().toLowerCase();

  async function generateAndSave(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile,
    generationOptions: PathGenerationOptions,
    budget: OllamaBudget | undefined = deps.generationBudget
  ): Promise<PathGenerationResult | PathGenerationError> {
    // The LLM call takes tens of seconds. Right before saving, re-read the dish
    // and the stored dietary needs; if either changed (a new allergy, or the
    // dish was swapped), the recipe is stale and is NOT saved. Regenerate once
    // with the fresh inputs; if they change again, return a retryable error.
    // Joiners share this whole promise, so none of them gets a stale recipe.
    let currentSlot = slot;
    let currentProfile = userProfile;
    let result: Awaited<ReturnType<typeof generateRecipe>> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await generateRecipe(deps.ollamaClient, currentSlot, currentProfile, {
        budget,
        ...generationOptions,
      });
      if (!result.success) return result;

      // A failed re-read throws, like a failed save: nothing is stored.
      const freshSlot = await deps.supabase.getPathSlot(slot.id, userId);
      const freshProfile = await deps.supabase.getUserProfile(userId);
      const used = new Set((currentProfile.dietaryNeeds ?? []).map(normalizeNeed));
      const addedNeeds = (freshProfile?.dietaryNeeds ?? []).filter((n) => !used.has(normalizeNeed(n)));
      const stale = !freshSlot || !freshProfile || freshSlot.dishName !== currentSlot.dishName || addedNeeds.length > 0;
      if (!stale) break;

      logger.warn('recipe_generation_stale', { slot_id: slot.id });
      result = null;
      if (attempt === 1 || !freshSlot || !freshProfile) {
        return {
          success: false,
          error: {
            type: 'stale',
            message: 'Your dish or dietary needs changed while the recipe was generating. Please try again.',
            attempts: 1,
          },
        };
      }
      currentSlot = freshSlot;
      // Keep the used needs (body extras too) and add the fresh stored ones.
      currentProfile = {
        ...freshProfile,
        dietaryNeeds: [...(currentProfile.dietaryNeeds ?? []), ...addedNeeds],
      };
    }
    if (!result || !result.success) {
      return { success: false, error: { type: 'stale', message: 'Please try again.', attempts: 1 } };
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
      logger.warn('recipe_videos_failed', {
        slot_id: slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
    if (!lookup.complete) {
      logger.warn('recipe_videos_incomplete', { slot_id: slotId, found: Object.keys(lookup.videos).length });
      return lookup.videos;
    }
    try {
      await deps.supabase.saveVideos(userId, slotId, lookup.videos);
    } catch (error) {
      logger.warn('recipe_videos_save_failed', {
        slot_id: slotId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return lookup.videos;
  }

  async function generate(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile,
    generationOptions: PathGenerationOptions = {}
  ): Promise<PathGenerationResult | PathGenerationError> {
    const key = `${userId}:${slot.id}`;
    const startedAt = (deps.generationBudget?.now ?? Date.now)();

    const inFlight = inFlightGenerations.get(key);
    if (inFlight) {
      const shared = await inFlight.promise;
      // A background generation that ended for its own reasons must not strand
      // a joiner: preempted for a real request, refused as busy (immediateOnly
      // or a refused retry), or stopped early by shouldRetry. The joiner then
      // runs its own foreground generation, once, with whatever is left of its
      // budget. A genuine failure after all attempts is returned as is, and a
      // foreground entry's result (even busy) is shared. A background caller
      // just stops.
      const reason = generationOptions.immediateOnly ? null : joinerRerunReason(shared, inFlight.background);
      if (!reason) return shared;
      logger.warn('recipe_joined_generation_rerun', { slot_id: slot.id, reason });
      if (inFlightGenerations.get(key) === inFlight) inFlightGenerations.delete(key);
      deps.hooks?.beforeRerun?.();
      const budget = deps.generationBudget && {
        ...deps.generationBudget,
        budgetMs: deps.generationBudget.budgetMs - ((deps.generationBudget.now ?? Date.now)() - startedAt),
      };
      return run(userId, slot, userProfile, generationOptions, budget);
    }

    return run(userId, slot, userProfile, generationOptions, deps.generationBudget);
  }

  async function run(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile,
    generationOptions: PathGenerationOptions,
    budget: OllamaBudget | undefined
  ): Promise<PathGenerationResult | PathGenerationError> {
    const key = `${userId}:${slot.id}`;
    // Another joiner may already have started the replacement generation.
    let existing = inFlightGenerations.get(key);
    if (existing && (generationOptions.immediateOnly || !existing.background)) return existing.promise;
    if (existing) {
      // A new prewarm registered while this foreground joiner was stranded.
      // Never replace a running prewarm (two model calls at once): wait for it.
      // If it ends for its own limits (preempted, busy, retry skipped), rerun
      // once, here, with what is left. A model failure is returned as is.
      const waitStartedAt = (deps.generationBudget?.now ?? Date.now)();
      const prewarm = existing;
      const shared = await prewarm.promise;
      const reason = joinerRerunReason(shared, true);
      if (!reason) return shared;
      logger.warn('recipe_joined_generation_rerun', { slot_id: slot.id, reason });
      if (inFlightGenerations.get(key) === prewarm) inFlightGenerations.delete(key);
      deps.hooks?.beforeRerun?.();
      // Another stranded joiner may have started the rerun already: share it.
      existing = inFlightGenerations.get(key);
      if (existing && !existing.background) return existing.promise;
      budget = budget && {
        ...budget,
        budgetMs: budget.budgetMs - ((budget.now ?? Date.now)() - waitStartedAt),
      };
    }

    const generationPromise = generateAndSave(userId, slot, userProfile, generationOptions, budget);
    const entry = { promise: generationPromise, background: generationOptions.immediateOnly === true };
    inFlightGenerations.set(key, entry);

    try {
      return await generationPromise;
    } finally {
      if (inFlightGenerations.get(key) === entry) inFlightGenerations.delete(key);
    }
  }

  return { generate, attachVideos };
}
