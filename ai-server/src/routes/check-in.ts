import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { CheckInIdempotencyConflict, CheckInInputSchema, CheckInMasterySessionError, isGeneratedCheckIn, isPathCheckIn } from '../types/check-in.js';
import type { CheckInService } from '../services/check-in-service.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';
import { createAuthMiddleware } from '../middleware/authenticate.js';
import { createPreAuthIpLimiter } from '../middleware/pre-auth-ip-limiter.js';

export interface CheckInRouterDeps {
  checkInService: CheckInService;
  jwtVerifier: JwtVerifier;
}

export interface CheckInRouterOptions {
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  /** Per-IP limit (before auth). */
  ipRateLimit?: {
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

  // Per-IP, BEFORE auth, so unauthenticated floods and token-verification
  // calls are bounded too. Behind a reverse proxy set TRUST_PROXY=true so
  // req.ip is the real client. Looser than the per-user cap because many
  // students can share one NAT or tunnel IP.
  const ipLimiter = createPreAuthIpLimiter(options.ipRateLimit);

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
   * After the check-in is saved, the server awards XP via award_slot_xp
   * using the service role (the client never calls award_slot_xp). If the
   * award fails, the check-in is still saved and xp.status is 'failed'.
   * 
   * Request body:
   * {
   *   user_recipe_id: string (UUID),
   *   slot_id: number (1-10),
   *   rating: "easy" | "ok" | "hard",
   *   went_well?: string (max 500 chars),
   *   was_hard?: string (max 500 chars),
   *   mastery_session_id?: string (UUID; final slot only, F8 — from POST /api/mastery/sessions)
   *   mastery?: { hidden_steps, revealed_steps }  (deprecated, accepted but ignored)
   *   idempotency_key?: string (UUID; reused on retry, stored as check_ins.id)
   * }
   * 
   * Response:
   * {
   *   check_in_id: string,
   *   coach_note: string,
   *   focus_area?: string,
   *   xp: { status: 'awarded', xp_awarded: number, is_first_completion: boolean, capped: boolean }
   *     | { status: 'failed' } | { status: 'skipped' },
   *   badges: { status: 'ok', earned: Badge[] } | { status: 'failed' } | { status: 'skipped' },
   *   suggest_repeat: boolean   // true when rated "hard" (F6)
   * }
   */
  // B3 fix: authenticate runs BEFORE userLimiter
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', ipLimiter, authenticate, userLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
      // N15: Guard against middleware reordering instead of using non-null assertion
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const userId = req.userId;

      const input = CheckInInputSchema.parse(req.body);

      const isValidRecipe = isGeneratedCheckIn(input)
        ? await deps.checkInService.validateGeneratedRecipe(userId, input.generated_recipe_id)
        : isPathCheckIn(input)
          ? await deps.checkInService.validateUserRecipe(userId, input.user_recipe_id, input.slot_id)
          : false;

      if (!isValidRecipe) {
        res.status(400).json({ 
          error: isGeneratedCheckIn(input)
            ? 'Invalid generated_recipe_id'
            : 'Invalid user_recipe_id or slot_id mismatch',
          code: 'INVALID_RECIPE'
        });
        return;
      }

      if (!(await deps.checkInService.isMasteryInputAllowed(input))) {
        res.status(400).json({
          error: 'mastery is only allowed for the final (mastery challenge) recipe',
          code: 'MASTERY_NOT_ALLOWED',
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
          details: error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      if (error instanceof CheckInMasterySessionError) {
        res.status(error.code === 'MASTERY_SESSION_USED' ? 409 : 400).json({
          error: error.message,
          code: error.code,
        });
        return;
      }

      if (error instanceof CheckInIdempotencyConflict) {
        res.status(409).json({
          error: error.message,
          code: error.code,
        });
        return;
      }

      console.error('check_in_error', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
