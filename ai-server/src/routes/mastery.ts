import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { createAuthMiddleware } from '../middleware/authenticate.js';
import { createPreAuthIpLimiter } from '../middleware/pre-auth-ip-limiter.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';
import { MasteryError, type MasteryErrorCode, type MasteryRepository } from '../repositories/mastery-repository.js';

export interface MasteryRouterDeps {
  jwtVerifier: JwtVerifier;
  masteryRepository: MasteryRepository;
}

export interface MasteryRouterOptions {
  rateLimit?: { windowMs: number; maxRequests: number };
  /** Per-IP limit (before auth). */
  ipRateLimit?: { windowMs: number; maxRequests: number };
}

const StartBodySchema = z.object({ slot_id: z.number().int().min(1).max(10) });
const RevealBodySchema = z.object({ step_index: z.number().int().min(0).max(29) });
const SessionIdSchema = z.string().uuid();

const ERROR_STATUS: Record<MasteryErrorCode, { status: number; message: string }> = {
  SLOT_NOT_FINAL: { status: 400, message: 'Only the final recipe on the path is a mastery challenge.' },
  RECIPE_NOT_FOUND: { status: 404, message: 'Open the recipe first so it can be written for you.' },
  SLOT_LOCKED: { status: 403, message: 'This recipe is locked. Finish the earlier recipes on your path first.' },
  MASTERY_SESSION_NOT_FOUND: { status: 404, message: 'Mastery session not found.' },
  MASTERY_SESSION_USED: { status: 409, message: 'This mastery session is already checked in. Start cooking again for a new one.' },
  STEP_NOT_HIDDEN: { status: 400, message: 'That step is not hidden in this challenge.' },
};

/**
 * F8 mastery challenge, server-side reveals.
 *
 * POST /api/mastery/sessions                       { slot_id }
 *   Starts (or resumes) the user's open session for the final slot.
 *   201 { session_id, hidden_step_indices, revealed_steps: { [index]: step } }
 *
 * POST /api/mastery/sessions/:sessionId/reveal     { step_index }
 *   Records the reveal (idempotent) and returns the step's full content.
 *   200 { step_index, step, hidden_step_indices, revealed_step_indices }
 *
 * The recipe route masks hidden steps on the final slot, so this is the only
 * way to read their text. The check-in sends session_id and the database
 * copies the counts from the session.
 */
export function createMasteryRouter(deps: MasteryRouterDeps, options: MasteryRouterOptions = {}): Router {
  const router = Router();
  const authenticate = createAuthMiddleware(deps.jwtVerifier);

  // Per-IP, BEFORE auth, so unauthenticated floods and token-verification
  // calls are bounded too. Behind a reverse proxy set TRUST_PROXY=true so
  // req.ip is the real client. Looser than the per-user cap because many
  // students can share one NAT or tunnel IP.
  const ipLimiter = createPreAuthIpLimiter(options.ipRateLimit);

  // Per-user, after auth. Reveals are cheap single-row updates, so the limit
  // is more generous than recipe generation but still bounded.
  const userLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60000,
    max: options.rateLimit?.maxRequests ?? 60,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      if (!req.userId) throw new Error('Rate limiter called without authenticated user');
      return req.userId;
    },
    validate: { xForwardedForHeader: false },
  });

  function fail(res: Response, error: unknown, label: string): void {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (error instanceof MasteryError) {
      const { status, message } = ERROR_STATUS[error.code];
      res.status(status).json({ error: message, code: error.code });
      return;
    }
    console.error(label, { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/sessions', ipLimiter, authenticate, userLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const { slot_id } = StartBodySchema.parse(req.body);
      const session = await deps.masteryRepository.start(req.userId, slot_id);
      res.status(201).json({
        session_id: session.sessionId,
        hidden_step_indices: session.hiddenStepIndices,
        revealed_steps: session.revealedSteps,
      });
    } catch (error) {
      fail(res, error, 'mastery_start_failed');
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/sessions/:sessionId/reveal', ipLimiter, authenticate, userLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const sessionId = SessionIdSchema.safeParse(req.params.sessionId);
      if (!sessionId.success) {
        res.status(400).json({ error: 'Invalid session id', code: 'VALIDATION_ERROR' });
        return;
      }
      const { step_index } = RevealBodySchema.parse(req.body);
      const reveal = await deps.masteryRepository.reveal(req.userId, sessionId.data, step_index);
      res.json({
        step_index: reveal.stepIndex,
        step: reveal.step,
        hidden_step_indices: reveal.hiddenStepIndices,
        revealed_step_indices: reveal.revealedStepIndices,
      });
    } catch (error) {
      fail(res, error, 'mastery_reveal_failed');
    }
  });

  return router;
}
