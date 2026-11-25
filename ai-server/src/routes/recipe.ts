import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createPathRecipeService, type PathRecipeService } from '../services/path-recipe-service.js';
import { generateRecipe, PathSlot } from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { OllamaBudget } from '../services/ollama-budget.js';
import { sendGenerationBusy } from './generation-busy.js';
import type { SupabaseService } from '../services/supabase.js';
import { storedTechniqueVideosMatch, type VideoFinder } from '../services/video-finder.js';
import type { DishPhoto, DishPhotoFinder } from '../services/dish-photo.js';
import type { DishVideo, DishVideoFinder } from '../services/dish-video-finder.js';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import { youtubeWatchUrl } from '../cook-anything/youtube-url.js';
import { maskRecipeForMastery } from '../mastery/mask.js';
import {
  UserProfile,
  UserProfileSchema,
  DietaryNeedsSchema,
} from '../schemas/user.js';
import { safeErrorFields } from '../services/safe-error.js';

const SLOT_ID_REGEX = /^\d+$/;

/**
 * Short, fixed text for 400 validation responses. Zod issues are never sent to
 * the client (they can echo field names and values); the issue paths and codes
 * are logged instead.
 */
const VALIDATION_DETAILS = 'One or more fields are missing or invalid.';

function logValidationFailure(route: string, error: z.ZodError): void {
  console.warn('recipe_validation_failed', {
    route,
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
}

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
  /** Per-request time budget for the model queue and calls. No deadline when unset. */
  generationBudget?: OllamaBudget;
  supabase: SupabaseService;
  /** F4 technique videos. Without it (no YOUTUBE_API_KEY) recipes have no videos. */
  videoFinder?: VideoFinder | null;
  photoFinder?: DishPhotoFinder | null;
  dishVideoFinder?: DishVideoFinder | null;
  /** Shared single-flight generator. Built from the deps above when omitted (tests). */
  pathRecipes?: PathRecipeService;
}

export interface RecipeRouterOptions {
  enablePreviewRoute?: boolean;
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

export function createRecipeRouter(
  deps: RecipeRouterDeps,
  options: RecipeRouterOptions = {}
): Router {
  const router = Router();

  // The same instance the check-in prewarmer uses, so a request that arrives
  // while a prewarm runs joins it instead of starting a second model call.
  const pathRecipes =
    deps.pathRecipes ??
    createPathRecipeService({
      ollamaClient: deps.ollamaClient,
      generationBudget: deps.generationBudget,
      supabase: deps.supabase,
      videoFinder: deps.videoFinder,
    });

  // IP-based rate limiter to prevent LLM resource exhaustion.
  // NOTE: Behind a tunnel, set TRUST_PROXY=true. index.ts then trusts
  // X-Forwarded-For only from a loopback peer, so req.ip is the client the
  // tunnel forwarded. Without it, everyone behind the tunnel shares one bucket.
  const ipLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60000,
    max: options.rateLimit?.maxRequests ?? 10,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.use(ipLimiter);

  async function dishMedia(dishName: string): Promise<{ photo: DishPhoto | null; dish_videos: DishVideo[] }> {
    const key = normalizeDishName(dishName);
    const [photo, dishVideos] = await Promise.all([
      (async (): Promise<DishPhoto | null> => {
        if (!key || !deps.photoFinder) return null;
        try {
          const lookup = await deps.photoFinder.findForDish(key);
          return lookup.photo;
        } catch (error) {
          console.warn('recipe_photo_failed', {
            ...safeErrorFields(error),
          });
          return null;
        }
      })(),
      (async (): Promise<DishVideo[]> => {
        if (!key || !deps.dishVideoFinder) return [];
        try {
          const lookup = await deps.dishVideoFinder.findForDish(key);
          return lookup.videos.flatMap((video) => {
            const url = youtubeWatchUrl(video.videoId);
            return url ? [{ ...video, url }] : [];
          });
        } catch (error) {
          console.warn('recipe_dish_videos_failed', {
            ...safeErrorFields(error),
          });
          return [];
        }
      })(),
    ]);
    return { photo, dish_videos: dishVideos };
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
            code: 'AUTH_UNAVAILABLE',
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
        logValidationFailure('generate', paramsResult.error);
        res.status(400).json({
          error: 'Invalid slot ID',
          details: VALIDATION_DETAILS,
        });
        return;
      }

      const bodyResult = GenerateRecipeBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        logValidationFailure('generate', bodyResult.error);
        res.status(400).json({
          error: 'Invalid request body',
          details: VALIDATION_DETAILS,
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
        const mediaPromise = dishMedia(slot.dishName);
        const storedVideos = await deps.supabase.getSavedVideos(userId, slotId);
        // A saved map skips the shared-cache check. Drop a titled video that
        // no longer names its technique and look the recipe up again. A video
        // with no title stays. The column is replaced only when that lookup
        // finishes; it is not cleared.
        const videosPromise =
          storedVideos && storedTechniqueVideosMatch(storedVideos)
            ? Promise.resolve(storedVideos)
            : pathRecipes.attachVideos(userId, slotId, existingRecipe);
        const [videos, media] = await Promise.all([videosPromise, mediaPromise]);
        // F8: the final slot's hidden steps are only served by a mastery reveal.
        res.json({
          recipe: slot.isFinal ? maskRecipeForMastery(existingRecipe) : existingRecipe,
          cached: true,
          videos,
          ...media,
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

      // Photo and dish videos don't depend on the recipe, so look them up while
      // Ollama generates. dishMedia never rejects (it catches internally).
      const mediaPromise = dishMedia(slot.dishName);
      const result = await pathRecipes.generate(userId, slot, profileForGeneration);

      if (!result.success) {
        // mediaPromise is left to settle on its own; it never rejects.
        if (result.error.type === 'busy') {
          sendGenerationBusy(res);
          return;
        }
        // Only safe enum/number fields: the error message can carry model output.
        console.error('recipe_generation_route_failed', {
          slot_id: slot.id,
          type: result.error.type,
          attempts: result.error.attempts,
          retry_skipped: result.error.retrySkipped === true,
        });
        res.status(500).json({
          error: 'Recipe generation failed. Please try again.',
          type: result.error.type,
          attempts: result.error.attempts,
        });
        return;
      }

      const media = await mediaPromise;
      res.json({
        recipe: slot.isFinal ? maskRecipeForMastery(result.recipe) : result.recipe,
        cached: false,
        videos: result.videos,
        ...media,
      });
    } catch (error) {
      console.error('recipe_generation_route_error', {
        ...safeErrorFields(error),
      });
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
     * SECURITY: This route is disabled by default. Enable with ENABLE_PREVIEW_ROUTE=true
     * outside production. NODE_ENV=production forces it off (isPreviewRouteEnabled).
     * It is rate-limited but not authenticated, so it is only for dev environments.
     *
     * Requires full slot and userProfile in request body.
     * Does not save the recipe or check for cached versions.
     */
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    router.post('/generate-preview', async (req: Request, res: Response) => {
      try {
        const parseResult = PreviewRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          logValidationFailure('generate-preview', parseResult.error);
          res.status(400).json({
            error: 'Invalid request body',
            details: VALIDATION_DETAILS,
          });
          return;
        }

        const { slot, userProfile } = parseResult.data as {
          slot: PathSlot;
          userProfile: UserProfile;
        };

        const result = await generateRecipe(deps.ollamaClient, slot, userProfile, {
          budget: deps.generationBudget,
        });

        if (!result.success) {
          if (result.error.type === 'busy') {
            sendGenerationBusy(res);
            return;
          }
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
