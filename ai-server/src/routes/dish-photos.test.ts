import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDishPhotoRouter } from './dish-photos.js';
import type { DishPhoto, DishPhotoFinder } from '../services/dish-photo.js';
import type { SupabaseService } from '../services/supabase.js';
import { SupabaseRestError } from '../services/supabase-rest.js';

const PHOTO: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
  credit: {
    author: 'Jane Cook',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
  },
};

function setup(options: {
  tokenValid?: boolean;
  userId?: string;
  allowed?: ReadonlySet<string> | Error;
  find?: DishPhotoFinder['findForDish'];
  maxRequests?: number;
  ipMaxRequests?: number;
} = {}): { app: express.Express; findForDish: ReturnType<typeof vi.fn>; verifyToken: ReturnType<typeof vi.fn> } {
  const findForDish = vi.fn(
    options.find ??
      ((name: string): Promise<{ photo: DishPhoto | null; complete: boolean }> =>
        Promise.resolve({ photo: name === 'pho' ? PHOTO : null, complete: true }))
  );
  const supabase = {
    verifyToken: vi.fn().mockResolvedValue(
      options.tokenValid === false
        ? { valid: false, error: 'invalid_token' }
        : { valid: true, userId: options.userId ?? 'user-1' }
    ),
  } as unknown as SupabaseService;
  const listKnownDishNames =
    options.allowed instanceof Error
      ? vi.fn().mockRejectedValue(options.allowed)
      : options.allowed
        ? vi.fn().mockResolvedValue(options.allowed)
        : vi.fn().mockResolvedValue(new Set(['pho']));
  const app = express();
  app.use(express.json());
  app.use(
    '/api/dish-photos',
    createDishPhotoRouter(
      {
        supabase,
        photoFinder: { findForDish } as unknown as DishPhotoFinder,
        listKnownDishNames,
      },
      {
        rateLimit: { windowMs: 60_000, maxRequests: options.maxRequests ?? 100 },
        ipRateLimit: { windowMs: 60_000, maxRequests: options.ipMaxRequests ?? 1000 },
      }
    )
  );
  return {
    app,
    findForDish: findForDish as ReturnType<typeof vi.fn>,
    verifyToken: supabase.verifyToken as unknown as ReturnType<typeof vi.fn>,
  };
}

const auth = { Authorization: 'Bearer t' };

describe('POST /api/dish-photos', () => {
  it('needs a valid login', async () => {
    const { app, findForDish } = setup({ tokenValid: false });
    const res = await request(app).post('/api/dish-photos').send({ dishes: ['pho'] });
    expect(res.status).toBe(401);
    const denied = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    expect(denied.status).toBe(401);
    expect(findForDish).not.toHaveBeenCalled();
  });

  it('looks up known dishes and returns null for names the server does not know', async () => {
    const { app, findForDish } = setup({ allowed: new Set(['pho']) });
    const res = await request(app)
      .post('/api/dish-photos')
      .set(auth)
      .send({ dishes: ['Pho', 'invisible stew', 'pho'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ photos: { pho: PHOTO, 'invisible stew': null } });
    expect(findForDish).toHaveBeenCalledTimes(1);
    expect(findForDish).toHaveBeenCalledWith('pho');
  });

  it('returns nulls without searching when the allowlist cannot be loaded', async () => {
    const { app, findForDish } = setup({ allowed: new Error('rest down') });
    const res = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ photos: { pho: null } });
    expect(findForDish).not.toHaveBeenCalled();
  });

  it('rate limits by user id after auth', async () => {
    const { app } = setup({ maxRequests: 2, allowed: new Set(['pho']) });
    const first = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    const second = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    const third = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('rate limits by IP before auth, so a flood never reaches token verification', async () => {
    const { app, verifyToken, findForDish } = setup({ ipMaxRequests: 2 });
    const first = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    const second = await request(app).post('/api/dish-photos').send({ dishes: ['pho'] });
    const third = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'Too many requests, please try again later' });
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(findForDish).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/dish-photos unexpected error logging', () => {
  it('logs only the error name, not the raw error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // A malformed allowlist (no .has) throws a TypeError outside the per-dish catch.
      const { app } = setup({ allowed: {} as unknown as ReadonlySet<string> });

      const res = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(errorSpy).toHaveBeenCalledWith('dish_photo_lookup_error', { error: 'TypeError' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('allowed.has');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('POST /api/dish-photos allowlist failure logging', () => {
  it('logs the Supabase status but not the response body', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { app } = setup({
        allowed: new SupabaseRestError('Supabase read failed: 500 {"hint":"cook@simmer.invalid"}', 500),
      });

      const res = await request(app).post('/api/dish-photos').set(auth).send({ dishes: ['pho'] });

      expect(res.status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith('dish_photo_allowlist_failed', {
        error: 'SupabaseRestError',
        status: 500,
        kind: 'http',
      });
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('cook@simmer.invalid');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
