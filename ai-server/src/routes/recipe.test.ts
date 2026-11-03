import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import type { PathSlot } from '../services/recipe-generator.js';

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
  } = {}
): SupabaseService {
  return {
    verifyToken: vi.fn().mockResolvedValue({
      valid: options.tokenValid ?? false,
      userId: options.tokenValid ? (options.userId ?? 'test-user-id') : undefined,
    }),
    getUserProfile: vi.fn().mockResolvedValue(options.userProfile ?? null),
    getPathSlot: vi.fn().mockResolvedValue(options.pathSlot ?? null),
    getSavedRecipe: vi.fn().mockResolvedValue(options.savedRecipe ?? null),
    saveRecipe: vi.fn().mockResolvedValue(undefined),
  };
}

function createApp(
  deps: { ollamaClient: OllamaClient; supabase: SupabaseService },
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
