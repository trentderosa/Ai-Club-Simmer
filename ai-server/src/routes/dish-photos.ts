import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import type { DishPhoto, DishPhotoFinder } from '../services/dish-photo.js';
import type { SupabaseService } from '../services/supabase.js';

const BodySchema = z.object({
  dishes: z.array(z.string().max(200)).max(12),
});

export interface DishPhotoRouterDeps {
  supabase: SupabaseService;
  photoFinder: DishPhotoFinder;
}

/**
 * Batch dish-photo lookup for screens that show a background before a recipe
 * response exists (Today, recipe book). Same finder and cache as recipe
 * generation. A miss or failure is null for that name and never fails the
 * request.
 */
export function createDishPhotoRouter(
  deps: DishPhotoRouterDeps,
  options: { rateLimit?: { windowMs: number; maxRequests: number } } = {}
): Router {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: options.rateLimit?.windowMs ?? 60_000,
      max: options.rateLimit?.maxRequests ?? 30,
      message: { error: 'Too many requests, please try again later' },
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid authorization header' });
        return;
      }
      const authResult = await deps.supabase.verifyToken(authHeader.slice(7));
      if (!authResult.valid || !authResult.userId) {
        if (authResult.error === 'service_unavailable') {
          res.status(503).json({ error: 'Authentication service temporarily unavailable' });
          return;
        }
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }

      const keys = [...new Set(parsed.data.dishes.map((name) => normalizeDishName(name)).filter((name) => name.length > 0))];
      const photos: Record<string, DishPhoto | null> = {};
      await Promise.all(
        keys.map(async (key) => {
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
