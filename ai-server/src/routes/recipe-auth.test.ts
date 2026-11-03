import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRecipeRouter } from './recipe.js';
import { createSupabaseService } from '../services/supabase.js';
import { createJwtVerifier } from '../services/jwt-verifier.js';
import { InMemoryUserRecipeRepository } from '../repositories/user-recipe-repository.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import type { PathSlot } from '../services/recipe-generator.js';

const TEST_SECRET = 'test-jwt-secret-for-integration-tests';
const USER_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_B_ID = '660e8400-e29b-41d4-a716-446655440001';

const validRecipe: Recipe = {
  title: 'Test Recipe',
  ingredients: [{ name: 'test', amount: '1 cup' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Test step', isSafetyStep: false }],
};

const mockUserProfile: UserProfile = {
  id: USER_A_ID,
  experienceLevel: 'never_cooked',
  budget: 'low',
  equipment: ['stove', 'pan'],
};

const mockSlot: PathSlot = {
  id: 1,
  dishName: 'Test Dish',
  techniqueFocus: 'basic technique',
};

function createValidToken(userId: string, expiresIn = '1h'): string {
  return jwt.sign({ sub: userId }, TEST_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  } as jwt.SignOptions);
}

function createExpiredToken(userId: string): string {
  return jwt.sign({ sub: userId }, TEST_SECRET, {
    algorithm: 'HS256',
    expiresIn: '-1h',
  } as jwt.SignOptions);
}

function createMockOllamaClient(): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue(JSON.stringify(validRecipe)),
  };
}

interface TestAppOptions {
  ollamaClient?: OllamaClient;
  userRecipeRepository?: InMemoryUserRecipeRepository;
  getUserProfile?: (userId: string) => Promise<UserProfile | null>;
  getPathSlot?: (slotId: number) => Promise<PathSlot | null>;
}

function createTestApp(options: TestAppOptions = {}): {
  app: express.Express;
  ollamaClient: OllamaClient;
  userRecipeRepository: InMemoryUserRecipeRepository;
  supabase: ReturnType<typeof createSupabaseService>;
} {
  const ollamaClient = options.ollamaClient ?? createMockOllamaClient();
  const userRecipeRepository =
    options.userRecipeRepository ?? new InMemoryUserRecipeRepository();

  const jwtVerifier = createJwtVerifier({ jwtSecret: TEST_SECRET });

  const supabase = createSupabaseService({
    jwtVerifier,
    userRecipeRepository,
  });

  if (options.getUserProfile) {
    supabase.getUserProfile = options.getUserProfile;
  } else {
    supabase.getUserProfile = vi.fn().mockResolvedValue(mockUserProfile);
  }

  if (options.getPathSlot) {
    supabase.getPathSlot = options.getPathSlot;
  } else {
    supabase.getPathSlot = vi.fn().mockResolvedValue(mockSlot);
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/api/recipes',
    createRecipeRouter(
      { ollamaClient, supabase },
      { rateLimit: { windowMs: 60000, maxRequests: 100 } }
    )
  );

  return { app, ollamaClient, userRecipeRepository, supabase };
}

describe('JWT Authentication', () => {
  describe('valid tokens', () => {
    it('accepts a valid JWT token and extracts user ID', async () => {
      const { app, supabase } = createTestApp();
      const token = createValidToken(USER_A_ID);

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(supabase.getUserProfile).toHaveBeenCalledWith(USER_A_ID);
    });

    it('returns recipe for authenticated user', async () => {
      const { app } = createTestApp();
      const token = createValidToken(USER_A_ID);

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.recipe).toEqual(validRecipe);
    });
  });

  describe('invalid tokens', () => {
    it('rejects token signed with wrong secret', async () => {
      const { app } = createTestApp();
      const badToken = jwt.sign({ sub: USER_A_ID }, 'wrong-secret', {
        algorithm: 'HS256',
      });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${badToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid or expired token');
    });

    it('rejects malformed token', async () => {
      const { app } = createTestApp();

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', 'Bearer not.a.valid.jwt');

      expect(response.status).toBe(401);
    });

    it('rejects token without sub claim', async () => {
      const { app } = createTestApp();
      const noSubToken = jwt.sign({ foo: 'bar' }, TEST_SECRET, {
        algorithm: 'HS256',
      });

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${noSubToken}`);

      expect(response.status).toBe(401);
    });
  });

  describe('expired tokens', () => {
    it('rejects an expired token', async () => {
      const { app } = createTestApp();
      const expiredToken = createExpiredToken(USER_A_ID);

      const response = await request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid or expired token');
    });
  });
});

describe('Cross-user access control', () => {
  it('user A cannot see user B saved recipe', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();
    const { app: appA } = createTestApp({ userRecipeRepository });

    const tokenA = createValidToken(USER_A_ID);

    await request(appA)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(userRecipeRepository.getAll()).toHaveLength(1);

    const tokenB = createValidToken(USER_B_ID);
    const { app: appBCheck } = createTestApp({
      userRecipeRepository,
      ollamaClient: {
        generate: vi.fn().mockResolvedValue(
          JSON.stringify({ ...validRecipe, title: 'User B Recipe' })
        ),
      },
    });

    const responseB = await request(appBCheck)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(responseB.status).toBe(200);
    expect(responseB.body.cached).toBe(false);
    expect(responseB.body.recipe.title).toBe('User B Recipe');
  });

  it('each user gets their own recipe for same slot', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();

    let callCount = 0;
    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(JSON.stringify({
          ...validRecipe,
          title: `Recipe ${callCount}`,
        }));
      }),
    };

    const { app } = createTestApp({ userRecipeRepository, ollamaClient });

    const tokenA = createValidToken(USER_A_ID);
    const tokenB = createValidToken(USER_B_ID);

    const responseA = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${tokenA}`);

    const responseB = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(responseA.body.recipe.title).toBe('Recipe 1');
    expect(responseB.body.recipe.title).toBe('Recipe 2');
    expect(ollamaClient.generate).toHaveBeenCalledTimes(2);
  });
});

describe('Saved recipe caching', () => {
  it('second request returns saved recipe without calling Ollama', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();
    const ollamaClient = createMockOllamaClient();
    const { app } = createTestApp({ userRecipeRepository, ollamaClient });

    const token = createValidToken(USER_A_ID);

    const response1 = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${token}`);

    expect(response1.status).toBe(200);
    expect(response1.body.cached).toBe(false);
    expect(ollamaClient.generate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    const response2 = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${token}`);

    expect(response2.status).toBe(200);
    expect(response2.body.cached).toBe(true);
    expect(response2.body.recipe).toEqual(validRecipe);
    expect(ollamaClient.generate).not.toHaveBeenCalled();
  });

  it('different slots generate different recipes', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();

    let callCount = 0;
    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(JSON.stringify({
          ...validRecipe,
          title: `Slot ${callCount} Recipe`,
        }));
      }),
    };

    const mockSlot1: PathSlot = { id: 1, dishName: 'Dish 1', techniqueFocus: 'tech1' };
    const mockSlot2: PathSlot = { id: 2, dishName: 'Dish 2', techniqueFocus: 'tech2' };

    const { app } = createTestApp({
      userRecipeRepository,
      ollamaClient,
      getPathSlot: vi.fn().mockImplementation((slotId: number) => {
        return Promise.resolve(slotId === 1 ? mockSlot1 : mockSlot2);
      }),
    });

    const token = createValidToken(USER_A_ID);

    const response1 = await request(app)
      .post('/api/recipes/generate/1')
      .set('Authorization', `Bearer ${token}`);

    const response2 = await request(app)
      .post('/api/recipes/generate/2')
      .set('Authorization', `Bearer ${token}`);

    expect(response1.body.recipe.title).toBe('Slot 1 Recipe');
    expect(response2.body.recipe.title).toBe('Slot 2 Recipe');
    expect(ollamaClient.generate).toHaveBeenCalledTimes(2);
  });
});

describe('Concurrent first requests', () => {
  it('produces exactly one row and one Ollama call for concurrent requests', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();

    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve(JSON.stringify(validRecipe)), 50);
        });
      }),
    };

    const { app } = createTestApp({ userRecipeRepository, ollamaClient });
    const token = createValidToken(USER_A_ID);

    const requests = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${token}`)
    );

    const responses = await Promise.all(requests);

    responses.forEach((response) => {
      expect(response.status).toBe(200);
      expect(response.body.recipe).toEqual(validRecipe);
    });

    expect(userRecipeRepository.getAll()).toHaveLength(1);

    const cachedResponses = responses.filter((r) => r.body.cached === true);
    const freshResponses = responses.filter((r) => r.body.cached === false);
    expect(freshResponses.length + cachedResponses.length).toBe(5);
  });

  it('all concurrent requests return the same recipe', async () => {
    const userRecipeRepository = new InMemoryUserRecipeRepository();

    const ollamaClient: OllamaClient = {
      generate: vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve(JSON.stringify(validRecipe)), 20);
        });
      }),
    };

    const { app } = createTestApp({ userRecipeRepository, ollamaClient });
    const token = createValidToken(USER_A_ID);

    const requests = Array.from({ length: 10 }, () =>
      request(app)
        .post('/api/recipes/generate/1')
        .set('Authorization', `Bearer ${token}`)
    );

    const responses = await Promise.all(requests);

    const recipes = responses.map((r) => r.body.recipe as Recipe);
    const uniqueTitles = new Set(recipes.map((r) => r.title));

    expect(uniqueTitles.size).toBe(1);
    expect(recipes[0].title).toBe('Test Recipe');
  });
});
