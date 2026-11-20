import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { DishPhoto, DishPhotoFinder } from '../services/dish-photo.js';
import type { DishVideo, DishVideoFinder } from '../services/dish-video-finder.js';
import type { RecipeVideos, VideoFinder, VideoLookupResult } from '../services/video-finder.js';
import type { GeneratedRecipeRepository } from '../repositories/generated-recipe-repository.js';
import { DishValidationError, validateDishQuery } from '../cook-anything/dish-name.js';
import { clampRecipeCounts, computeFreeformXp } from '../cook-anything/clamp.js';
import { COOK_ANYTHING_MAX_DISH_LENGTH } from '../cook-anything/constants.js';
import {
  GenerationRateLimiter,
  type CookAnythingGenerationLimiter,
} from '../cook-anything/rate-limit.js';
import { generateCookAnythingRecipe } from '../cook-anything/generator.js';
import { sanitizeRecipeVideos, youtubeWatchUrl } from '../cook-anything/youtube-url.js';

export interface CookAnythingRouterDeps {
  ollamaClient: OllamaClient;
  supabase: SupabaseService;
  generatedRecipes: GeneratedRecipeRepository;
  videoFinder?: VideoFinder | null;
  photoFinder?: DishPhotoFinder | null;
  dishVideoFinder?: DishVideoFinder | null;
}

export interface CookAnythingRouterOptions {
  rateLimit?: { windowMs: number; maxRequests: number };
  generationRateLimit?: { windowMs: number; maxGenerations: number };
  /** When set, this limiter is used instead of an in-memory one built from generationRateLimit. */
  generationLimiter?: CookAnythingGenerationLimiter;
  maxDishLength?: number;
}

type GenerationWorkError = { error: { type: string; message: string; attempts: number } };

type GenerationLimitBlock = { limit: 'rate_limited' } | { limit: 'unavailable' };

export function createCookAnythingRouter(
  deps: CookAnythingRouterDeps,
  options: CookAnythingRouterOptions = {}
): Router {
  const router = Router();
  const maxDishLength = options.maxDishLength ?? COOK_ANYTHING_MAX_DISH_LENGTH;
  const generationLimiter: CookAnythingGenerationLimiter =
    options.generationLimiter ??
    new GenerationRateLimiter(
      options.generationRateLimit?.windowMs ?? 3_600_000,
      options.generationRateLimit?.maxGenerations ?? 5
    );
  const inFlight = new Map<
    string,
    Promise<CookAnythingHttpResponse | GenerationWorkError | GenerationLimitBlock>
  >();

  const ipLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    max: options.rateLimit?.maxRequests ?? 10,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use(ipLimiter);

  async function attachVideos(
    recipeId: string,
    userId: string,
    recipe: Parameters<VideoFinder['findForRecipe']>[0]
  ): Promise<RecipeVideos> {
    if (!deps.videoFinder) return {};
    let lookup: VideoLookupResult;
    try {
      lookup = await deps.videoFinder.findForRecipe(recipe);
    } catch (error) {
      console.warn('cook_anything_videos_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
    const videos = sanitizeRecipeVideos(lookup.videos);
    if (!lookup.complete) return videos;
    try {
      await deps.generatedRecipes.saveVideos(userId, recipeId, videos);
    } catch (error) {
      console.warn('cook_anything_videos_save_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return videos;
  }

  async function attachPhoto(
    recipeId: string,
    userId: string,
    normalizedDishName: string,
    existing: DishPhoto | null
  ): Promise<DishPhoto | null> {
    if (existing) return existing;
    if (!deps.photoFinder) return null;
    let lookup;
    try {
      lookup = await deps.photoFinder.findForDish(normalizedDishName);
    } catch (error) {
      console.warn('cook_anything_photo_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!lookup.complete || !lookup.photo) return lookup.photo ?? null;
    try {
      await deps.generatedRecipes.savePhoto(userId, recipeId, lookup.photo);
    } catch (error) {
      console.warn('cook_anything_photo_save_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return lookup.photo;
  }

  async function attachDishVideos(normalizedDishName: string): Promise<DishVideo[]> {
    if (!deps.dishVideoFinder) return [];
    try {
      const lookup = await deps.dishVideoFinder.findForDish(normalizedDishName);
      return lookup.videos.flatMap((video) => {
        const url = youtubeWatchUrl(video.videoId);
        return url ? [{ ...video, url }] : [];
      });
    } catch (error) {
      console.warn('cook_anything_dish_videos_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  type CookAnythingHttpResponse = {
    generated_recipe_id: string;
    dish_query: string;
    normalized_dish_name: string;
    recipe: unknown;
    cached: boolean;
    videos: RecipeVideos;
    dish_videos: DishVideo[];
    photo: DishPhoto | null;
    xp_value: number;
    counts: { steps: number; ingredients: number; minutes: number };
  };

  function toResponse(
    saved: {
      id: string;
      dishQuery: string;
      normalizedDishName: string;
      recipe: unknown;
      videos: RecipeVideos | null;
      stepCount: number;
      ingredientCount: number;
      timeEstimateMinutes: number;
      xpValue: number;
    },
    videos: RecipeVideos,
    dishVideos: DishVideo[],
    photo: DishPhoto | null,
    cached: boolean
  ): CookAnythingHttpResponse {
    return {
      generated_recipe_id: saved.id,
      dish_query: saved.dishQuery,
      normalized_dish_name: saved.normalizedDishName,
      recipe: saved.recipe,
      cached,
      videos,
      dish_videos: dishVideos,
      photo,
      xp_value: saved.xpValue,
      counts: {
        steps: saved.stepCount,
        ingredients: saved.ingredientCount,
        minutes: saved.timeEstimateMinutes,
      },
    };
  }

  type GenerationWorkResult =
    | CookAnythingHttpResponse
    | GenerationWorkError
    | GenerationLimitBlock;

  function sendGenerationResult(res: Response, result: GenerationWorkResult): void {
    if ('limit' in result) {
      if (result.limit === 'rate_limited') {
        res.status(429).json({
          error: 'Too many new recipes for now. Try a dish you’ve already cooked, or wait and try again.',
          code: 'GENERATION_RATE_LIMITED',
        });
        return;
      }
      res.status(503).json({
        error: 'New recipes are temporarily unavailable. Try a dish you already saved, or try again later.',
        code: 'GENERATION_RATE_LIMIT_UNAVAILABLE',
      });
      return;
    }
    if ('error' in result && result.error) {
      res.status(500).json({
        error: 'Recipe generation failed. Please try again.',
        type: result.error.type,
        attempts: result.error.attempts,
      });
      return;
    }
    res.json(result);
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/cook-anything', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid authorization header' });
        return;
      }
      const token = authHeader.slice(7);
      const authResult = await deps.supabase.verifyToken(token);
      if (!authResult.valid || !authResult.userId) {
        if (authResult.error === 'service_unavailable') {
          res.status(503).json({ error: 'Authentication service temporarily unavailable' });
          return;
        }
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      const userId = authResult.userId;

      let dishQuery: string;
      let normalizedDishName: string;
      try {
        const parsed = validateDishQuery(
          (req.body as { dish?: unknown } | undefined)?.dish,
          maxDishLength
        );
        dishQuery = parsed.dishQuery;
        normalizedDishName = parsed.normalizedDishName;
      } catch (error) {
        if (error instanceof DishValidationError) {
          res.status(400).json({
            error: error.message,
            code: 'INVALID_DISH',
            reason: error.code,
          });
          return;
        }
        throw error;
      }

      const existing = await deps.generatedRecipes.findByUserAndNormalizedName(
        userId,
        normalizedDishName
      );
      if (existing) {
        const storedVideos = existing.videos;
        const [videos, photo, dishVideos] = await Promise.all([
          storedVideos
            ? Promise.resolve(storedVideos)
            : attachVideos(existing.id, userId, existing.recipe),
          attachPhoto(existing.id, userId, existing.normalizedDishName, existing.photo),
          attachDishVideos(existing.normalizedDishName),
        ]);
        res.json(toResponse(existing, sanitizeRecipeVideos(videos), dishVideos, photo, true));
        return;
      }

      const userProfile = await deps.supabase.getUserProfile(userId);
      if (!userProfile) {
        res.status(404).json({
          error: 'User profile not found. Please complete onboarding first.',
        });
        return;
      }

      const flightKey = `${userId}:${normalizedDishName}`;
      const pending = inFlight.get(flightKey);
      if (pending) {
        sendGenerationResult(res, await pending);
        return;
      }

      // Register before any await. allow() is a round trip, and a second
      // request for this dish must join this promise instead of spending
      // another generation and starting another model call.
      const work = (async (): Promise<GenerationWorkResult> => {
        let allowed: boolean;
        try {
          allowed = await generationLimiter.allow(userId);
        } catch (error) {
          console.error('cook_anything_rate_limit_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { limit: 'unavailable' };
        }
        if (!allowed) {
          return { limit: 'rate_limited' };
        }

        const result = await generateCookAnythingRecipe(
          deps.ollamaClient,
          dishQuery,
          userProfile
        );
        if (!result.success) {
          return { error: result.error };
        }
        const clamped = clampRecipeCounts(result.recipe);
        const xpValue = computeFreeformXp(
          clamped.stepCount,
          clamped.ingredientCount,
          clamped.timeEstimateMinutes
        );
        const saved = await deps.generatedRecipes.save({
          userId,
          dishQuery,
          normalizedDishName,
          recipe: clamped.recipe,
          stepCount: clamped.stepCount,
          ingredientCount: clamped.ingredientCount,
          timeEstimateMinutes: clamped.timeEstimateMinutes,
          xpValue,
        });
        const [videos, photo, dishVideos] = await Promise.all([
          attachVideos(saved.id, userId, saved.recipe),
          attachPhoto(saved.id, userId, saved.normalizedDishName, saved.photo),
          attachDishVideos(saved.normalizedDishName),
        ]);
        return toResponse(saved, videos, dishVideos, photo, false);
      })();

      inFlight.set(flightKey, work);
      try {
        sendGenerationResult(res, await work);
      } finally {
        inFlight.delete(flightKey);
      }
    } catch (error) {
      console.error('Cook-anything generation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
