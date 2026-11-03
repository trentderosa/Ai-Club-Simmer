import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateRecipe, PathSlot } from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import {
  UserProfile,
  UserProfileSchema,
  DietaryNeedsSchema,
} from '../schemas/user.js';

// Validates slot ID from URL params
const GenerateRecipeParamsSchema = z.object({
  slotId: z.number().int().positive(),
});

// Optional body for /generate/:slotId - allows overriding dietary needs
// since they're not yet in PRD onboarding (F1)
const GenerateRecipeBodySchema = z
  .object({
    dietaryNeeds: DietaryNeedsSchema.optional(),
  })
  .optional();

// Full validation schema for the preview endpoint
// Only includes fields needed for recipe generation (no extra user data)
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
}

export function createRecipeRouter(deps: RecipeRouterDeps): Router {
  const router = Router();

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
      // Auth validation
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
        res.status(401).json({
          error: 'Invalid or expired token',
        });
        return;
      }

      const userId = authResult.userId;

      // Validate URL params
      const paramsResult = GenerateRecipeParamsSchema.safeParse({
        slotId: parseInt(req.params.slotId, 10),
      });

      if (!paramsResult.success) {
        res.status(400).json({
          error: 'Invalid slot ID',
          details: paramsResult.error.errors,
        });
        return;
      }

      // Validate optional body (dietaryNeeds)
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

      // Check for cached recipe (PRD F3: "same saved recipe is used every time after")
      const existingRecipe = await deps.supabase.getSavedRecipe(userId, slotId);
      if (existingRecipe) {
        res.json({
          recipe: existingRecipe,
          cached: true,
        });
        return;
      }

      // Fetch path slot
      const slot = await deps.supabase.getPathSlot(slotId);
      if (!slot) {
        res.status(404).json({
          error: `Path slot ${slotId} not found`,
        });
        return;
      }

      // Fetch user profile
      const userProfile = await deps.supabase.getUserProfile(userId);
      if (!userProfile) {
        res.status(404).json({
          error: 'User profile not found. Please complete onboarding first.',
        });
        return;
      }

      // Apply dietary needs override if provided (merges with profile)
      const profileForGeneration: UserProfile = dietaryNeedsOverride
        ? { ...userProfile, dietaryNeeds: dietaryNeedsOverride }
        : userProfile;

      const result = await generateRecipe(
        deps.ollamaClient,
        slot,
        profileForGeneration
      );

      // Never return partial data - either full valid recipe or error
      if (!result.success) {
        res.status(500).json({
          error: result.error.message,
          type: result.error.type,
          attempts: result.error.attempts,
        });
        return;
      }

      // Save for future requests (PRD F3: "isn't regenerated on later visits")
      await deps.supabase.saveRecipe(userId, slotId, result.recipe);

      res.json({
        recipe: result.recipe,
        cached: false,
      });
    } catch (error) {
      console.error('Recipe generation error:', error);
      res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * POST /api/recipes/generate-preview
   *
   * Preview endpoint for testing recipe generation without auth or persistence.
   * Useful for development and testing the LLM integration.
   *
   * Requires full slot and userProfile in request body.
   * Does not save the recipe or check for cached versions.
   */
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/generate-preview', async (req: Request, res: Response) => {
    try {
      // Validate all inputs strictly
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

      // Never return partial data - either full valid recipe or error
      if (!result.success) {
        res.status(500).json({
          error: result.error.message,
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

  return router;
}
