import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { CheckInInputSchema } from '../types/check-in.js';
import { requireAuth } from '../middleware/auth.js';
import type { CheckInService } from '../services/check-in-service.js';

export function createCheckInRouter(checkInService: CheckInService): Router {
  const router = Router();

  /**
   * POST /check-ins
   * Create a post-cook check-in and receive a Coach's note.
   * 
   * Requires authentication via Supabase JWT.
   * Does NOT award XP - the client should call award_slot_xp separately
   * (or XP is awarded via server-side trigger in PR #2's schema).
   * 
   * Request body:
   * {
   *   user_recipe_id: string (UUID),
   *   slot_id: number (1-10),
   *   rating: "easy" | "ok" | "hard",
   *   went_well?: string (max 500 chars),
   *   was_hard?: string (max 500 chars)
   * }
   * 
   * Response:
   * {
   *   check_in_id: string,
   *   coach_note: string,
   *   focus_area?: string
   * }
   */
  router.post('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const input = CheckInInputSchema.parse(req.body);

      const isValidRecipe = await checkInService.validateUserRecipe(
        req.user.id,
        input.user_recipe_id,
        input.slot_id
      );

      if (!isValidRecipe) {
        res.status(400).json({ 
          error: 'Invalid user_recipe_id or slot_id mismatch',
          code: 'INVALID_RECIPE'
        });
        return;
      }

      const response = await checkInService.processCheckIn(req.user.id, input);
      
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      console.error('Check-in error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
