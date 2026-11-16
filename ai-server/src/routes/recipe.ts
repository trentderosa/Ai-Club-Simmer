import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { generateRecipe, PathSlot } from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { Recipe } from '../schemas/recipe.js';
import type { RecipeVideos, VideoFinder, VideoLookupResult } from '../services/video-finder.js';
import { maskRecipeForMastery } from '../mastery/mask.js';
import {
  UserProfile,
  UserProfileSchema,
  DietaryNeedsSchema,
} from '../schemas/user.js';

const SLOT_ID_REGEX = /^\d+$/;

const GenerateRecipeParamsSchema = z.object({
  slotId: z.number().int().positive(),
});

const GenerateRecipeBodySchema = z
  .object({
    dietaryNeeds: DietaryNeedsSchema.optional(),
  })
  .optional();

const PreviewRequestSchema = z.object({
  slot: z.object({
    id: z.number().int().positive(),
    dishName: z.string().min(1).max(200),
    techniqueFocus: z.string().min(1).max(200),
  }),
  userProfile: UserProfileSchema,
});

export interface RecipeRouterDeps {
  ollamaClient: OllamaClient;
  supabase: SupabaseService;
  /** F4 technique videos. Without it (no YOUTUBE_API_KEY) recipes have no videos. */
  videoFinder?: VideoFinder | null;
}

export interface RecipeRouterOptions {
  enablePreviewRoute?: boolean;
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

interface GenerationResult {
  success: true;
  recipe: Recipe;
  videos: RecipeVideos;
}

interface GenerationError {
  success: false;
  error: { type: string; message: string; attempts: number };
}

export function createRecipeRouter(
  deps: RecipeRouterDeps,
  options: RecipeRouterOptions = {}
): Router {
  const router = Router();

  const inFlightGenerations = new Map<string, Promise<GenerationResult | GenerationError>>();

  // IP-based rate limiter to prevent LLM resource exhaustion.
  // NOTE: Behind a reverse proxy, set app.set('trust proxy', 1) in index.ts
  // so req.ip reflects the real client IP, not the proxy's IP. Without this,
  // all users behind the proxy share one bucket.
  const ipLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60000,
    max: options.rateLimit?.maxRequests ?? 10,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.use(ipLimiter);

  function makeGenerationKey(userId: string, slotId: number): string {
    return `${userId}:${slotId}`;
  }

  async function generateAndSave(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile
  ): Promise<GenerationResult | GenerationError> {
    const result = await generateRecipe(deps.ollamaClient, slot, userProfile);

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

  async function singleFlightGenerate(
    userId: string,
    slot: PathSlot,
    userProfile: UserProfile
  ): Promise<GenerationResult | GenerationError> {
    const key = makeGenerationKey(userId, slot.id);

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

  /**
   * POST /api/recipes/generate/:slotId
   *
   * Generates a recipe for the authenticated user and path slot.
   * Returns cached recipe if one exists, otherwise calls Ollama.
   *
   * Optional body: { dietaryNeeds?: string[] }
   * - Dietary needs are not yet in PRD onboarding (F1), so they can be
   *   passed here for testing or future feature rollout.
   */
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/generate/:slotId', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          error: 'Missing or invalid authorization header',
        });
        return;
      }

      const token = authHeader.slice(7);
      const authResult = await deps.supabase.verifyToken(token);
      if (!authResult.valid || !authResult.userId) {
        if (authResult.error === 'service_unavailable') {
          res.status(503).json({
            error: 'Authentication service temporarily unavailable',
          });
          return;
        }
        res.status(401).json({
          error: 'Invalid or expired token',
        });
        return;
      }

      const userId = authResult.userId;

      const rawSlotId = req.params.slotId;
      if (!SLOT_ID_REGEX.test(rawSlotId)) {
        res.status(400).json({
          error: 'Invalid slot ID: must be a positive integer',
        });
        return;
      }

      const paramsResult = GenerateRecipeParamsSchema.safeParse({
        slotId: parseInt(rawSlotId, 10),
      });

      if (!paramsResult.success) {
        res.status(400).json({
          error: 'Invalid slot ID',
          details: paramsResult.error.errors,
        });
        return;
      }

      const bodyResult = GenerateRecipeBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: bodyResult.error.errors,
        });
        return;
      }

      const { slotId } = paramsResult.data;
      const dietaryNeedsOverride = bodyResult.data?.dietaryNeeds;

      // One slot lookup for both the cached and generate paths. A missing
      // slot is 404 even if a saved recipe exists, so we never fail open and
      // leak hidden step text.
      const slot = await deps.supabase.getPathSlot(slotId);
      if (!slot) {
        res.status(404).json({
          error: `Path slot ${slotId} not found`,
        });
        return;
      }

      const existingRecipe = await deps.supabase.getSavedRecipe(userId, slotId);
      if (existingRecipe) {
        // null = never stored (or the last lookup was incomplete): look again.
        const storedVideos = await deps.supabase.getSavedVideos(userId, slotId);
        const videos = storedVideos ?? (await attachVideos(userId, slotId, existingRecipe));
        // F8: the final slot's hidden steps are only served by a mastery reveal.
        res.json({
          recipe: slot.isFinal ? maskRecipeForMastery(existingRecipe) : existingRecipe,
          cached: true,
          videos,
        });
        return;
      }

      // F2: only the current slot (or an already-done one, to repeat it) can
      // be started. Checked after the cache (saved recipes always load) and
      // after the slot lookup (an unknown slot is a 404, not locked).
      const unlocked = await deps.supabase.isSlotUnlocked(userId, slotId);
      if (!unlocked) {
        res.status(403).json({
          error: 'This recipe is locked. Finish the earlier recipes on your path first.',
          code: 'SLOT_LOCKED',
        });
        return;
      }

      const userProfile = await deps.supabase.getUserProfile(userId);
      if (!userProfile) {
        res.status(404).json({
          error: 'User profile not found. Please complete onboarding first.',
        });
        return;
      }

      const profileForGeneration: UserProfile = dietaryNeedsOverride
        ? { ...userProfile, dietaryNeeds: dietaryNeedsOverride }
        : userProfile;

      const result = await singleFlightGenerate(userId, slot, profileForGeneration);

      if (!result.success) {
        console.error('Recipe generation failed:', result.error);
        res.status(500).json({
          error: 'Recipe generation failed. Please try again.',
          type: result.error.type,
          attempts: result.error.attempts,
        });
        return;
      }

      res.json({
        recipe: slot.isFinal ? maskRecipeForMastery(result.recipe) : result.recipe,
        cached: false,
        videos: result.videos,
      });
    } catch (error) {
      console.error('Recipe generation error:', error);
      res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  if (options.enablePreviewRoute) {
    /**
     * POST /api/recipes/generate-preview
     *
     * Preview endpoint for testing recipe generation without auth or persistence.
     * Useful for development and testing the LLM integration.
     *
     * SECURITY: This route is disabled by default. Enable with ENABLE_PREVIEW_ROUTE=true.
     * It is rate-limited but not authenticated, so should only be used in dev environments.
     *
     * Requires full slot and userProfile in request body.
     * Does not save the recipe or check for cached versions.
     */
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    router.post('/generate-preview', async (req: Request, res: Response) => {
      try {
        const parseResult = PreviewRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            error: 'Invalid request body',
            details: parseResult.error.errors,
          });
          return;
        }

        const { slot, userProfile } = parseResult.data as {
          slot: PathSlot;
          userProfile: UserProfile;
        };

        const result = await generateRecipe(deps.ollamaClient, slot, userProfile);

        if (!result.success) {
          console.error('Recipe generation preview failed:', result.error);
          res.status(500).json({
            error: 'Recipe generation failed. Please try again.',
            type: result.error.type,
            attempts: result.error.attempts,
          });
          return;
        }

        res.json({
          recipe: result.recipe,
        });
      } catch (error) {
        console.error('Recipe generation preview error:', error);
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    });
  }

  return router;
}
