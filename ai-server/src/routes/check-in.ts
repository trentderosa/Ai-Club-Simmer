import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { CheckInInputSchema } from '../types/check-in.js';
import type { CheckInService } from '../services/check-in-service.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';

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

  // S1: Per-user rate limiter after auth to prevent LLM abuse
  const userLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60000,
    max: options.rateLimit?.maxRequests ?? 10,
    message: { error: 'Too many check-ins, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Use user ID from request (set by auth middleware below)
      // Falls back to 'unknown' when userId not yet set (before auth runs)
      return (req as Request & { userId?: string }).userId || 'unknown';
    },
    // Skip IP-based validation since we use userId, not IP
    validate: { xForwardedForHeader: false },
  });

  /**
   * POST /api/check-ins
   * Create a post-cook check-in and receive a Coach's note.
   * 
   * Requires authentication via Supabase JWT (PR #3's verifier).
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
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', userLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
      // Auth validation using PR #3's JWT verifier
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          error: 'Missing or invalid authorization header',
        });
        return;
      }

      const token = authHeader.slice(7);
      const authResult = await deps.jwtVerifier.verify(token);

      if (authResult.error === 'service_unavailable') {
        res.status(503).json({ error: 'Authentication service unavailable' });
        return;
      }

      if (!authResult.valid || !authResult.userId) {
        const errorMessage = authResult.error === 'expired' 
          ? 'Token expired' 
          : 'Invalid or expired token';
        res.status(401).json({ error: errorMessage });
        return;
      }

      const userId = authResult.userId;
      // Store userId on request for rate limiter
      (req as Request & { userId?: string }).userId = userId;

      const input = CheckInInputSchema.parse(req.body);

      // N1: Only validate once (removed duplicate from service)
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
