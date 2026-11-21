import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createCookAnythingRouter } from './cook-anything.js';
import { OllamaBusyError } from '../services/ollama-gate.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { UserProfile } from '../schemas/user.js';
import type { CookAnythingGenerationLimiter } from '../cook-anything/rate-limit.js';
import { InMemoryGeneratedRecipeRepository } from '../repositories/in-memory-generated-recipe-repository.js';

const profile: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'a_little',
  budget: 'low',
  equipment: ['stove', 'pan'],
};

function supabase(): SupabaseService {
  return {
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'user-1' }),
    getUserProfile: vi.fn().mockResolvedValue(profile),
    getPathSlot: vi.fn().mockResolvedValue({ id: 1, dishName: 'Test Dish', techniqueFocus: 'basics' }),
    isSlotUnlocked: vi.fn().mockResolvedValue(true),
    getSavedVideos: vi.fn().mockResolvedValue(null),
    saveVideos: vi.fn().mockResolvedValue(undefined),
    getSavedRecipe: vi.fn().mockResolvedValue(null),
    saveRecipe: vi.fn(),
  };
}

const BUSY_BODY = {
  error: 'The kitchen is busy right now. Try again in a minute.',
  code: 'GENERATION_BUSY',
};

function busyClient(): OllamaClient & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn().mockRejectedValue(new OllamaBusyError('queue_full')) };
}

function limiterWith(
  allow: CookAnythingGenerationLimiter['allow'],
  refund: CookAnythingGenerationLimiter['refund'] = vi.fn().mockResolvedValue(true)
): CookAnythingGenerationLimiter {
  return { allow, refund };
}

function cookApp(
  client: OllamaClient & { isSaturated?: () => boolean },
  limiter: CookAnythingGenerationLimiter
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/recipes',
    createCookAnythingRouter(
      {
        ollamaClient: client,
        supabase: supabase(),
        generatedRecipes: new InMemoryGeneratedRecipeRepository(),
      },
      { rateLimit: { windowMs: 60_000, maxRequests: 100 }, generationLimiter: limiter }
    )
  );
  return app;
}

describe('GENERATION_BUSY', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /generate/:slotId returns 503 with Retry-After, and a joined request gets the same result', async () => {
    const client = busyClient();
    // Hold the model call open so the second request joins the first.
    let release: () => void = () => undefined;
    client.generate.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release = (): void => reject(new OllamaBusyError('queue_timeout'));
        })
    );
    const app = express();
    app.use(express.json());
    app.use(
      '/api/recipes',
      createRecipeRouter(
        { ollamaClient: client, supabase: supabase() },
        { rateLimit: { windowMs: 60_000, maxRequests: 100 } }
      )
    );
    const send = (): Promise<request.Response> =>
      request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer t')
        .then((r) => r);
    const first = send();
    await vi.waitFor(() => expect(client.generate).toHaveBeenCalledTimes(1));
    const second = send();
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, second]);
    for (const res of [a, b]) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual(BUSY_BODY);
      expect(res.headers['retry-after']).toBe('30');
    }
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  it('POST /generate-preview returns 503 GENERATION_BUSY when the model is busy', async () => {
    const client = busyClient();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/recipes',
      createRecipeRouter(
        { ollamaClient: client, supabase: supabase() },
        { rateLimit: { windowMs: 60_000, maxRequests: 100 }, enablePreviewRoute: true }
      )
    );
    const res = await request(app)
      .post('/api/recipes/generate-preview')
      .send({
        slot: { id: 1, dishName: 'Test Dish', techniqueFocus: 'basics' },
        userProfile: profile,
      });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(res.headers['retry-after']).toBe('30');
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  it('POST /cook-anything returns 503 with Retry-After when the model call is refused', async () => {
    const client = busyClient();
    const allow = vi.fn().mockResolvedValue(true);
    const limiter = limiterWith(allow);
    const res = await request(cookApp(client, limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(res.headers['retry-after']).toBe('30');
    expect(client.generate).toHaveBeenCalledTimes(1);
    expect(limiter.refund).toHaveBeenCalledTimes(1);
    expect(limiter.refund).toHaveBeenCalledWith('user-1');
  });

  it('POST /cook-anything with a saturated gate skips the rate limiter and the model', async () => {
    const client = Object.assign(busyClient(), { isSaturated: () => true });
    const allow = vi.fn().mockResolvedValue(true);
    const limiter = limiterWith(allow);
    const res = await request(cookApp(client, limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(res.headers['retry-after']).toBe('30');
    expect(allow).not.toHaveBeenCalled();
    expect(limiter.refund).not.toHaveBeenCalled();
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('POST /cook-anything refuses without calling the model when the queue fills during allow()', async () => {
    let saturated = false;
    const client = Object.assign(busyClient(), { isSaturated: () => saturated });
    const allow = vi.fn().mockImplementation(() => {
      saturated = true;
      return Promise.resolve(true);
    });
    const limiter = limiterWith(allow);
    const res = await request(cookApp(client, limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(res.headers['retry-after']).toBe('30');
    expect(allow).toHaveBeenCalledTimes(1);
    expect(limiter.refund).toHaveBeenCalledTimes(1);
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('POST /cook-anything joined requests get the same busy result', async () => {
    const client = Object.assign(busyClient(), { isSaturated: () => false });
    let release: () => void = () => undefined;
    const allow = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = (): void => resolve(true);
        })
    );
    const limiter = limiterWith(allow);
    const app = cookApp(client, limiter);
    const send = (): Promise<request.Response> =>
      request(app)
        .post('/api/recipes/cook-anything')
        .set('Authorization', 'Bearer t')
        .send({ dish: 'Pad Thai' })
        .then((r) => r);
    const first = send();
    await vi.waitFor(() => expect(allow).toHaveBeenCalledTimes(1));
    const second = send();
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(b.body).toEqual(BUSY_BODY);
    expect(allow).toHaveBeenCalledTimes(1);
    expect(limiter.refund).toHaveBeenCalledTimes(1);
  });

  it('POST /cook-anything keeps the 503 and logs the error name when the refund fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = busyClient();
    const limiter = limiterWith(
      vi.fn().mockResolvedValue(true),
      vi.fn().mockRejectedValue(new TypeError('secret detail'))
    );
    const res = await request(cookApp(client, limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(limiter.refund).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('cook_anything_refund_failed', { error: 'TypeError' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret detail');
  });

  it('POST /cook-anything logs cook_anything_generation_refunded when a hit is given back', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const limiter = limiterWith(vi.fn().mockResolvedValue(true));
    await request(cookApp(busyClient(), limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(info).toHaveBeenCalledWith('cook_anything_generation_refunded');
  });

  it('POST /cook-anything does not refund a busy result that follows a completed model call', async () => {
    const client = {
      generate: vi
        .fn()
        .mockResolvedValueOnce('not json')
        .mockRejectedValue(new OllamaBusyError('queue_timeout')),
    };
    const limiter = limiterWith(vi.fn().mockResolvedValue(true));
    const res = await request(cookApp(client, limiter))
      .post('/api/recipes/cook-anything')
      .set('Authorization', 'Bearer t')
      .send({ dish: 'Pad Thai' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY_BODY);
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(limiter.refund).not.toHaveBeenCalled();
  });

  it('POST /cook-anything does not refund a validation failure, a rate limit, or an Ollama error', async () => {
    const post = (app: express.Express, dish: string): request.Test =>
      request(app).post('/api/recipes/cook-anything').set('Authorization', 'Bearer t').send({ dish });

    const invalid = limiterWith(vi.fn().mockResolvedValue(true));
    expect((await post(cookApp(busyClient(), invalid), '')).status).toBe(400);
    expect(invalid.refund).not.toHaveBeenCalled();

    const limited = limiterWith(vi.fn().mockResolvedValue(false));
    expect((await post(cookApp(busyClient(), limited), 'Pad Thai')).status).toBe(429);
    expect(limited.refund).not.toHaveBeenCalled();

    const failing = { generate: vi.fn().mockRejectedValue(new Error('ollama down')) };
    const failed = limiterWith(vi.fn().mockResolvedValue(true));
    expect((await post(cookApp(failing, failed), 'Pad Thai')).status).toBe(500);
    expect(failed.refund).not.toHaveBeenCalled();
  });
});
