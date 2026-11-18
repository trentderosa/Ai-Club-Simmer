import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import { createAuthMiddleware } from '../middleware/authenticate.js';
import type { DishPhoto, DishPhotoFinder } from '../services/dish-photo.js';
import type { SupabaseService } from '../services/supabase.js';

const BodySchema = z.object({
  dishes: z.array(z.string().max(200)).max(12),
});

export interface DishPhotoRouterDeps {
  supabase: SupabaseService;
  photoFinder: DishPhotoFinder;
  /**
   * Names this user is allowed to look up (path slots + their Cook anything
   * dishes). Required in production. When omitted (dev without Supabase),
   * requested names are not filtered.
   */
  listKnownDishNames?: (userId: string) => Promise<ReadonlySet<string>>;
}

/**
 * Batch dish-photo lookup for screens that show a background before a recipe
 * response exists (Today, recipe book). Same finder and cache as recipe
 * generation. A miss or failure is null for that name and never fails the
 * request. Only the caller's known dish names are looked up.
 */
export function createDishPhotoRouter(
  deps: DishPhotoRouterDeps,
  options: {
    /** Per-user limit (after auth). */
    rateLimit?: { windowMs: number; maxRequests: number };
    /** Per-IP limit (before auth). */
    ipRateLimit?: { windowMs: number; maxRequests: number };
  } = {}
): Router {
  const router = Router();
  const authenticate = createAuthMiddleware({
    verify: (token: string) => deps.supabase.verifyToken(token),
  });

  // Per-IP, BEFORE auth, so unauthenticated floods and token-verification
  // calls are bounded too. NOTE: behind a reverse proxy, set TRUST_PROXY=true
  // (index.ts then calls app.set('trust proxy', 1)) so req.ip is the real
  // client IP; otherwise all users share the proxy's IP and one bucket.
  // The default is looser than the per-user cap because campus NAT can put
  // many students behind one IP.
  const ipLimiter = rateLimit({
    windowMs: options.ipRateLimit?.windowMs ?? 60_000,
    max: options.ipRateLimit?.maxRequests ?? 60,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Per-user, after auth, so one account can't multiply the cap by rotating IPs.
  const userLimiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    max: options.rateLimit?.maxRequests ?? 30,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      if (!req.userId) throw new Error('Rate limiter called without authenticated user');
      return req.userId;
    },
    validate: { xForwardedForHeader: false },
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', ipLimiter, authenticate, userLimiter, async (req: Request, res: Response) => {
    try {
      if (!req.userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }

      const requested = [
        ...new Set(parsed.data.dishes.map((name) => normalizeDishName(name)).filter((name) => name.length > 0)),
      ];

      let allowed: ReadonlySet<string> | null = null;
      if (deps.listKnownDishNames) {
        try {
          allowed = await deps.listKnownDishNames(req.userId);
        } catch (error) {
          console.warn('dish_photo_allowlist_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          const photos: Record<string, DishPhoto | null> = {};
          for (const key of requested) photos[key] = null;
          res.json({ photos });
          return;
        }
      }

      const photos: Record<string, DishPhoto | null> = {};
      await Promise.all(
        requested.map(async (key) => {
          if (allowed && !allowed.has(key)) {
            photos[key] = null;
            return;
          }
          try {
            const lookup = await deps.photoFinder.findForDish(key);
            photos[key] = lookup.photo;
          } catch (error) {
            console.warn('dish_photo_batch_failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            photos[key] = null;
          }
        })
      );
      res.json({ photos });
    } catch (error) {
      console.error('Dish photo lookup error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
