import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { RecipeVideos, VideoFinder, VideoLookupResult } from '../services/video-finder.js';
import type { GeneratedRecipeRepository } from '../repositories/generated-recipe-repository.js';
import { DishValidationError, validateDishQuery } from '../cook-anything/dish-name.js';
import { clampRecipeCounts, computeFreeformXp } from '../cook-anything/clamp.js';
import { COOK_ANYTHING_MAX_DISH_LENGTH } from '../cook-anything/constants.js';
import { GenerationRateLimiter } from '../cook-anything/rate-limit.js';
import { generateCookAnythingRecipe } from '../cook-anything/generator.js';
import { sanitizeRecipeVideos } from '../cook-anything/youtube-url.js';

export interface CookAnythingRouterDeps {
  ollamaClient: OllamaClient;
  supabase: SupabaseService;
  generatedRecipes: GeneratedRecipeRepository;
  videoFinder?: VideoFinder | null;
}

export interface CookAnythingRouterOptions {
  rateLimit?: { windowMs: number; maxRequests: number };
  generationRateLimit?: { windowMs: number; maxGenerations: number };
  maxDishLength?: number;
}

type GenerationWorkError = { error: { type: string; message: string; attempts: number } };

export function createCookAnythingRouter(
  deps: CookAnythingRouterDeps,
  options: CookAnythingRouterOptions = {}
): Router {
  const router = Router();
  const maxDishLength = options.maxDishLength ?? COOK_ANYTHING_MAX_DISH_LENGTH;
  const generationLimiter = new GenerationRateLimiter(
    options.generationRateLimit?.windowMs ?? 3_600_000,
    options.generationRateLimit?.maxGenerations ?? 5
  );
  const inFlight = new Map<string, Promise<CookAnythingHttpResponse | GenerationWorkError>>();

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

  type CookAnythingHttpResponse = {
    generated_recipe_id: string;
    dish_query: string;
    normalized_dish_name: string;
    recipe: unknown;
    cached: boolean;
    videos: RecipeVideos;
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
    cached: boolean
  ): CookAnythingHttpResponse {
    return {
      generated_recipe_id: saved.id,
      dish_query: saved.dishQuery,
      normalized_dish_name: saved.normalizedDishName,
      recipe: saved.recipe,
      cached,
      videos,
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
    | { error: { type: string; message: string; attempts: number } };

  function sendGenerationResult(res: Response, result: GenerationWorkResult): void {
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
        const videos =
          storedVideos ?? (await attachVideos(existing.id, userId, existing.recipe));
        res.json(toResponse(existing, sanitizeRecipeVideos(videos), true));
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

      if (!generationLimiter.allow(userId)) {
        res.status(429).json({
          error: 'Too many new recipes for now. Try a dish you’ve already cooked, or wait and try again.',
          code: 'GENERATION_RATE_LIMITED',
        });
        return;
      }

      const work = (async (): Promise<GenerationWorkResult> => {
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
        const videos = await attachVideos(saved.id, userId, saved.recipe);
        return toResponse(saved, videos, false);
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
