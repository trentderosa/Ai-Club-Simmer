import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { isPreviewRouteEnabled } from '../config.js';
import { SupabaseRestError } from '../services/supabase-rest.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import type { PathSlot } from '../services/recipe-generator.js';
import { DishPhotoFinder, InMemoryDishPhotoCache, type DishPhoto, type DishPhotoSearchClient } from '../services/dish-photo.js';
import { DishVideoFinder, InMemoryDishVideoCache, type DishVideoSearchClient } from '../services/dish-video-finder.js';

const validRecipe: Recipe = {
  title: 'Test Recipe',
  ingredients: [{ name: 'test', amount: '1 cup' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Test step', isSafetyStep: false }],
};

const mockUserProfile: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'never_cooked',
  budget: 'low',
  equipment: ['stove', 'pan'],
};

const mockSlot: PathSlot = {
  id: 1,
  dishName: 'Test Dish',
  techniqueFocus: 'basic technique',
};

function createMockOllamaClient(): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue(JSON.stringify(validRecipe)),
  };
}

function createMockSupabase(
  options: {
    tokenValid?: boolean;
    userId?: string;
    userProfile?: UserProfile | null;
    pathSlot?: PathSlot | null;
    savedRecipe?: Recipe | null;
    slotUnlocked?: boolean;
  } = {}
): SupabaseService {
  return {
    verifyToken: vi.fn().mockResolvedValue({
      valid: options.tokenValid ?? false,
      userId: options.tokenValid ? (options.userId ?? 'test-user-id') : undefined,
    }),
    getUserProfile: vi.fn().mockResolvedValue(options.userProfile ?? null),
    getPathSlot: vi.fn().mockResolvedValue(options.pathSlot ?? null),
    isSlotUnlocked: vi.fn().mockResolvedValue(options.slotUnlocked ?? true),
    getSavedVideos: vi.fn().mockResolvedValue(null),
    saveVideos: vi.fn().mockResolvedValue(undefined),
    getSavedRecipe: vi.fn().mockResolvedValue(options.savedRecipe ?? null),
    saveRecipe: vi.fn().mockImplementation((_userId: string, _slotId: number, recipe: Recipe) => 
      Promise.resolve(recipe)
    ),
  };
}

function createApp(
  deps: {
    ollamaClient: OllamaClient;
    supabase: SupabaseService;
    photoFinder?: DishPhotoFinder | null;
    dishVideoFinder?: DishVideoFinder | null;
  },
  options: { enablePreviewRoute?: boolean; rateLimit?: { windowMs: number; maxRequests: number } } = {}
): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/recipes', createRecipeRouter(deps, options));
  return app;
}

describe('POST /api/recipes/generate/:slotId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase(),
    });

    const response = await request(app).post('/api/recipes/generate/1');

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('authorization header');
  });

  it('returns 503 AUTH_UNAVAILABLE when the auth service is down', async () => {
    const supabase = createMockSupabase({ tokenValid: false });
    (supabase.verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      error: 'service_unavailable',
    });
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase,
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Authentication service temporarily unavailable',
      code: 'AUTH_UNAVAILABLE',
    });
  });

  it('returns 401 when token is invalid', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({ tokenValid: false }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('Invalid or expired token');
  });

  it('returns 401 for any token when stub auth is disabled (fail closed)', async () => {
    const supabase = createMockSupabase({ tokenValid: false });
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase,
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer any-random-token-should-fail');

    expect(response.status).toBe(401);
    expect(supabase.verifyToken).toHaveBeenCalledWith('any-random-token-should-fail');
  });

  it('returns 400 for non-numeric slot ID like "12abc"', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({ tokenValid: true }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/12abc')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('must be a positive integer');
  });

  it('returns 400 for negative slot ID', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({ tokenValid: true }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/-1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(400);
  });

  it('returns cached recipe without calling Ollama', async () => {
    const ollamaClient = createMockOllamaClient();
    const supabase = createMockSupabase({
      tokenValid: true,
      pathSlot: mockSlot,
      savedRecipe: validRecipe,
    });
    const app = createApp({ ollamaClient, supabase });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(true);
    expect(response.body.recipe).toEqual(validRecipe);
    expect(ollamaClient.generate).not.toHaveBeenCalled();
  });

  it('returns 404 when path slot is not found', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({
        tokenValid: true,
        pathSlot: null,
      }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/999')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Path slot 999 not found');
  });

  it('returns 404 when user profile is not found', async () => {
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({
        tokenValid: true,
        pathSlot: mockSlot,
        userProfile: null,
      }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('User profile not found');
  });

  it('generates and returns a recipe when all inputs are valid', async () => {
    const ollamaClient = createMockOllamaClient();
    const supabase = createMockSupabase({
      tokenValid: true,
      pathSlot: mockSlot,
      userProfile: mockUserProfile,
    });
    const app = createApp({ ollamaClient, supabase });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect(response.body.recipe).toEqual(validRecipe);
    expect(ollamaClient.generate).toHaveBeenCalled();
    expect(supabase.saveRecipe).toHaveBeenCalled();
  });

  it('returns a dish photo and dish videos for a path recipe, and hides videos when YouTube fails', async () => {
    const photo: DishPhoto = {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
      credit: {
        author: 'Jane Cook',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
      },
    };
    const photoSearch: DishPhotoSearchClient = { search: vi.fn().mockResolvedValue(photo) };
    const videoSearch: DishVideoSearchClient = {
      search: vi.fn().mockRejectedValue(new Error('YouTube search failed: 403 quotaExceeded')),
    };
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase: createMockSupabase({
        tokenValid: true,
        pathSlot: mockSlot,
        userProfile: mockUserProfile,
      }),
      photoFinder: new DishPhotoFinder(new InMemoryDishPhotoCache(), photoSearch),
      dishVideoFinder: new DishVideoFinder(new InMemoryDishVideoCache(), videoSearch, { warn: vi.fn() }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body.photo).toEqual(photo);
    expect(response.body.dish_videos).toEqual([]);
    expect(response.body.recipe.title).toBe('Test Recipe');
    expect(photoSearch.search).toHaveBeenCalledWith('test dish');
  });

  it('fetches the photo for the swapped dish when the dish changes mid-generation', async () => {
    const photoSearch: DishPhotoSearchClient = { search: vi.fn().mockResolvedValue(null) };
    const supabase = createMockSupabase({ tokenValid: true, pathSlot: mockSlot, userProfile: mockUserProfile });
    // Route read sees the old dish; the pre-save re-read sees the swap.
    (supabase.getPathSlot as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockSlot)
      .mockResolvedValue({ ...mockSlot, dishName: 'Shakshuka' });
    const app = createApp({
      ollamaClient: createMockOllamaClient(),
      supabase,
      photoFinder: new DishPhotoFinder(new InMemoryDishPhotoCache(), photoSearch),
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    const searched = (photoSearch.search as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(searched).toContain('shakshuka');
    expect(supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a timeout', new SupabaseRestError('Supabase recipe query timed out after 5000ms', undefined, { kind: 'timeout' }), 503],
    ['a non-timeout error', new SupabaseRestError('Supabase recipe query failed: 500', 500), 500],
  ])('maps a saved-recipe lookup failing with %s to %i', async (_name, error, status) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const supabase = createMockSupabase({ tokenValid: true, pathSlot: mockSlot, userProfile: mockUserProfile });
      (supabase.getSavedRecipe as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      const app = createApp({ ollamaClient: createMockOllamaClient(), supabase });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(status);
      expect(response.body).toEqual(
        status === 503
          ? {
              error: 'The database is not responding right now. Try again in a moment.',
              code: 'DATABASE_UNAVAILABLE',
            }
          : { error: 'Internal server error' }
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('hides internal error details from client', async () => {
    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockRejectedValue(new Error('Internal: model host at 192.168.1.100 failed')),
    };
    const app = createApp({
      ollamaClient,
      supabase: createMockSupabase({
        tokenValid: true,
        pathSlot: mockSlot,
        userProfile: mockUserProfile,
      }),
    });

    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Recipe generation failed. Please try again.');
    expect(response.body.error).not.toContain('192.168.1.100');
    expect(response.body.error).not.toContain('Internal:');
  });

  it('logs the fetch cause and Ollama host but keeps the client error generic', async () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    });
    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockRejectedValue(fetchError),
    };
    const previousBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const app = createApp({
        ollamaClient,
        supabase: createMockSupabase({
          tokenValid: true,
          pathSlot: mockSlot,
          userProfile: mockUserProfile,
        }),
      });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Recipe generation failed. Please try again.',
        type: 'generation_failed',
        attempts: 3,
      });
      expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(response.body)).not.toContain('ollama.internal');

      const logs = JSON.stringify(errorSpy.mock.calls);
      expect(logs).toContain('recipe_generation_failed');
      expect(logs).toContain('ECONNREFUSED');
      expect(logs).toContain('ollama.internal:11434');
    } finally {
      errorSpy.mockRestore();
      if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previousBaseUrl;
    }
  });

  it('logs only slot id, type and attempt count when generation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ollamaClient: OllamaClient = {
        generate: vi.fn().mockResolvedValue('not json sk-test-secret-token'),
      };
      const app = createApp({
        ollamaClient,
        supabase: createMockSupabase({
          tokenValid: true,
          pathSlot: mockSlot,
          userProfile: mockUserProfile,
        }),
      });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
      const call = errorSpy.mock.calls.find((c) => c[0] === 'recipe_generation_route_failed');
      expect(call).toBeDefined();
      expect(Object.keys(call?.[1] as object).sort()).toEqual(['attempts', 'retry_skipped', 'slot_id', 'type']);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-test-secret-token');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('logs only the error name when the generate route throws unexpectedly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const supabase = createMockSupabase({
        tokenValid: true,
        pathSlot: mockSlot,
        userProfile: mockUserProfile,
      });
      supabase.getUserProfile = vi
        .fn()
        .mockRejectedValue(new TypeError('profile row for cook@simmer.invalid is malformed'));
      const app = createApp({ ollamaClient: createMockOllamaClient(), supabase });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith('recipe_generation_route_error', { error: 'TypeError' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('cook@simmer.invalid');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('POST /api/recipes/generate-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when preview route is disabled (default)', async () => {
    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase(),
      },
      { enablePreviewRoute: false }
    );

    const response = await request(app)
      .post('/api/recipes/generate-preview')
      .send({
        slot: mockSlot,
        userProfile: mockUserProfile,
      });

    expect(response.status).toBe(404);
  });

  it('logs only a sanitized type and attempt count when preview generation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ollamaClient: OllamaClient = {
        generate: vi.fn().mockResolvedValue('not json sk-test-secret-token'),
      };
      const app = createApp(
        { ollamaClient, supabase: createMockSupabase() },
        { enablePreviewRoute: true }
      );

      const response = await request(app)
        .post('/api/recipes/generate-preview')
        .send({ slot: mockSlot, userProfile: mockUserProfile });

      expect(response.status).toBe(500);
      const call = errorSpy.mock.calls.find((c) => c[0] === 'recipe_generation_preview_failed');
      expect(call).toBeDefined();
      expect(Object.keys(call?.[1] as object).sort()).toEqual(['attempts', 'type']);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-test-secret-token');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('works when preview route is explicitly enabled', async () => {
    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase(),
      },
      { enablePreviewRoute: true }
    );

    const response = await request(app)
      .post('/api/recipes/generate-preview')
      .send({
        slot: mockSlot,
        userProfile: mockUserProfile,
      });

    expect(response.status).toBe(200);
    expect(response.body.recipe).toEqual(validRecipe);
  });

  it('stays off in production even when ENABLE_PREVIEW_ROUTE=true', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enabled = isPreviewRouteEnabled({
      NODE_ENV: 'production',
      ENABLE_PREVIEW_ROUTE: 'true',
    });

    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase(),
      },
      { enablePreviewRoute: enabled }
    );

    const response = await request(app)
      .post('/api/recipes/generate-preview')
      .send({
        slot: mockSlot,
        userProfile: mockUserProfile,
      });

    expect(enabled).toBe(false);
    expect(response.status).toBe(404);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ENABLE_PREVIEW_ROUTE=true is ignored when NODE_ENV=production')
    );
    warn.mockRestore();
  });

  it('turns on in dev when ENABLE_PREVIEW_ROUTE=true', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enabled = isPreviewRouteEnabled({
      NODE_ENV: 'development',
      ENABLE_PREVIEW_ROUTE: 'true',
    });

    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase(),
      },
      { enablePreviewRoute: enabled }
    );

    const response = await request(app)
      .post('/api/recipes/generate-preview')
      .send({
        slot: mockSlot,
        userProfile: mockUserProfile,
      });

    expect(enabled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.recipe).toEqual(validRecipe);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns 400 for invalid request body when enabled', async () => {
    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase(),
      },
      { enablePreviewRoute: true }
    );

    const response = await request(app)
      .post('/api/recipes/generate-preview')
      .send({ invalid: 'data' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid request body');
  });

  describe('validation errors do not echo zod issues', () => {
    const SHORT = 'One or more fields are missing or invalid.';

    it('preview: short details, issue paths and codes logged without input values', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const app = createApp(
        { ollamaClient: createMockOllamaClient(), supabase: createMockSupabase() },
        { enablePreviewRoute: true }
      );
      const response = await request(app)
        .post('/api/recipes/generate-preview')
        .send({ slot: 'secret-input-value' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid request body', details: SHORT });
      const call = warn.mock.calls.find(([name]) => name === 'recipe_validation_failed');
      expect(call).toBeDefined();
      const logged = JSON.stringify(call);
      expect(logged).toContain('"route":"generate-preview"');
      expect(logged).toMatch(/"path":"[^"]*","code":"[a-z_]+"/);
      expect(logged).not.toContain('secret-input-value');
      warn.mockRestore();
    });

    it('generate: bad slot id and bad body return the short details', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const app = createApp({
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase({ tokenValid: true }),
      });
      const badSlot = await request(app)
        .post('/api/recipes/generate/0')
        .set('Authorization', 'Bearer valid-token');
      expect(badSlot.status).toBe(400);
      expect(badSlot.body).toEqual({ error: 'Invalid slot ID', details: SHORT });

      const badBody = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer valid-token')
        .send({ dietaryNeeds: 'secret-input-value' });
      expect(badBody.status).toBe(400);
      expect(badBody.body).toEqual({ error: 'Invalid request body', details: SHORT });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-input-value');
      warn.mockRestore();
    });
  });
});

describe('Rate limiting', () => {
  it('returns 429 after exceeding rate limit', async () => {
    const app = createApp(
      {
        ollamaClient: createMockOllamaClient(),
        supabase: createMockSupabase({ tokenValid: true }),
      },
      { rateLimit: { windowMs: 60000, maxRequests: 2 } }
    );

    // First two requests should succeed (or get expected 4xx from validation)
    await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer token1');
    await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer token2');

    // Third request should be rate limited
    const response = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', 'Bearer token3');

    expect(response.status).toBe(429);
    expect(response.body.error).toContain('Too many requests');
  });
});
