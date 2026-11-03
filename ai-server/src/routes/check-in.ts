import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { CheckInInputSchema } from '../types/check-in.js';
import type { CheckInService } from '../services/check-in-service.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';
import { createAuthMiddleware } from '../middleware/authenticate.js';

export interface CheckInRouterDeps {
  checkInService: CheckInService;
  jwtVerifier: JwtVerifier;
}

export interface CheckInRouterOptions {
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

export function createCheckInRouter(
  deps: CheckInRouterDeps,
  options: CheckInRouterOptions = {}
): Router {
  const router = Router();

  // B3 fix: Auth middleware runs FIRST and sets req.userId
  const authenticate = createAuthMiddleware(deps.jwtVerifier);

  // S1/B3 fix: Per-user rate limiter runs AFTER auth, using the authenticated userId
  const userLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60000,
    max: options.rateLimit?.maxRequests ?? 10,
    message: { error: 'Too many check-ins, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      // B3 fix: userId is guaranteed to be set because auth middleware runs first
      // If somehow undefined, throw to prevent falling back to a global bucket
      if (!req.userId) {
        throw new Error('Rate limiter called without authenticated user');
      }
      return req.userId;
    },
    // Skip IP-based validation since we use userId, not IP
    validate: { xForwardedForHeader: false },
  });

  /**
   * POST /api/check-ins
   * Create a post-cook check-in and receive a Coach's note.
   * 
   * Requires authentication via Supabase JWT (PR #3's verifier).
   * This route does not award XP; XP awarding is owned by the
   * gamification flow and happens server-side only.
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
  // B3 fix: authenticate runs BEFORE userLimiter
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', authenticate, userLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
      // N15: Guard against middleware reordering instead of using non-null assertion
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const userId = req.userId;

      const input = CheckInInputSchema.parse(req.body);

      const isValidRecipe = await deps.checkInService.validateUserRecipe(
        userId,
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

      const response = await deps.checkInService.processCheckIn(userId, input);
      
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
