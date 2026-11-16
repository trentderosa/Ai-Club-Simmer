import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRecipeRouter } from './recipe.js';
import { createSupabaseService } from '../services/supabase.js';
import { createJwtVerifier } from '../services/jwt-verifier.js';
import { InMemoryUserRecipeRepository } from '../repositories/user-recipe-repository.js';
import type { PathRepository } from '../repositories/path-repository.js';
import { InMemoryTechniqueVideoCache, VideoFinder, type VideoSearchClient } from '../services/video-finder.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { Recipe } from '../schemas/recipe.js';

/**
 * F2 path gating and F4 technique videos on POST /api/recipes/generate/:slotId,
 * using the real SupabaseService with a fake PathRepository.
 */

const SECRET = 'test-jwt-secret-for-gating-tests';
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const recipe: Recipe = {
  title: 'Scrambled Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [
    { instruction: 'Whisk the eggs', isSafetyStep: false, techniqueName: 'Whisk eggs' },
    { instruction: 'Cook on low heat', isSafetyStep: true, techniqueName: 'Low heat cooking' },
    { instruction: 'Serve', isSafetyStep: false },
  ],
};

function token(): string {
  return jwt.sign({ sub: USER_ID }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function pathRepo(overrides: Partial<PathRepository> = {}): PathRepository {
  return {
    getPathSlot: vi.fn().mockResolvedValue({ id: 2, dishName: 'Scrambled Eggs', techniqueFocus: 'Heat control', isFinal: false }),
    getUserProfile: vi.fn().mockResolvedValue({
      id: USER_ID,
      experienceLevel: 'never_cooked',
      budget: 'low',
      equipment: ['stove', 'pan'],
    }),
    isSlotUnlocked: vi.fn().mockResolvedValue(true),
    badgesEarnedBy: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function setup(options: { pathRepository?: PathRepository; search?: VideoSearchClient | null } = {}): {
  app: express.Express;
  ollama: OllamaClient;
  recipes: InMemoryUserRecipeRepository;
  pathRepository: PathRepository;
  search: VideoSearchClient | null;
} {
  const ollama: OllamaClient = { generate: vi.fn().mockResolvedValue(JSON.stringify(recipe)) };
  const recipes = new InMemoryUserRecipeRepository();
  const pathRepository = options.pathRepository ?? pathRepo();
  const search =
    options.search === undefined
      ? { search: vi.fn().mockImplementation((q: string) => Promise.resolve({ videoId: q.includes('whisk') ? 'whisk01' : 'heat001' })) }
      : options.search;
  const supabase = createSupabaseService({
    jwtVerifier: createJwtVerifier({ jwtSecret: SECRET }),
    userRecipeRepository: recipes,
    pathRepository,
  });
  const videoFinder = search
    ? new VideoFinder(new InMemoryTechniqueVideoCache(), search, { warn: vi.fn() })
    : null;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/recipes',
    createRecipeRouter({ ollamaClient: ollama, supabase, videoFinder }, { rateLimit: { windowMs: 60000, maxRequests: 100 } })
  );
  return { app, ollama, recipes, pathRepository, search };
}

describe('F2 path gating', () => {
  it('a locked slot returns 403 SLOT_LOCKED and never calls the model', async () => {
    const { app, ollama, pathRepository } = setup({
      pathRepository: pathRepo({ isSlotUnlocked: vi.fn().mockResolvedValue(false) }),
    });

    const res = await request(app).post('/api/recipes/generate/5').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SLOT_LOCKED');
    expect(pathRepository.isSlotUnlocked).toHaveBeenCalledWith(USER_ID, 5);
    expect(ollama.generate).not.toHaveBeenCalled();
  });

  it('an unlocked slot generates and saves the recipe', async () => {
    const { app, recipes } = setup();

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.recipe.title).toBe('Scrambled Eggs');
    expect(recipes.getAll()).toHaveLength(1);
  });

  it('a saved recipe always loads, even if the gate would say locked', async () => {
    const { app, recipes, pathRepository } = setup({
      pathRepository: pathRepo({ isSlotUnlocked: vi.fn().mockResolvedValue(false) }),
    });
    await recipes.save(USER_ID, 2, recipe);

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(pathRepository.isSlotUnlocked).not.toHaveBeenCalled();
  });

  it('missing onboarding still returns 404 with the onboarding message', async () => {
    const { app } = setup({ pathRepository: pathRepo({ getUserProfile: vi.fn().mockResolvedValue(null) }) });
    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/onboarding/);
  });

  it('a gate error is a 500, not an open door', async () => {
    const { app, ollama } = setup({
      pathRepository: pathRepo({ isSlotUnlocked: vi.fn().mockRejectedValue(new Error('db down')) }),
    });
    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(500);
    expect(ollama.generate).not.toHaveBeenCalled();
  });
});

describe('F4 technique videos', () => {
  it('returns and stores one video per technique with the new recipe', async () => {
    const { app, recipes } = setup();

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.body.videos).toEqual({
      'Whisk eggs': { videoId: 'whisk01' },
      'Low heat cooking': { videoId: 'heat001' },
    });
    expect(recipes.getAll()[0].videos).toEqual(res.body.videos);
  });

  it('a cached recipe returns its stored videos without searching again', async () => {
    const { app, search } = setup();
    await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    vi.mocked(search!.search).mockClear();

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.body.cached).toBe(true);
    expect(res.body.videos['Whisk eggs']).toEqual({ videoId: 'whisk01' });
    expect(search!.search).not.toHaveBeenCalled();
  });

  it('a saved recipe without videos gets them on the next visit', async () => {
    const { app, recipes } = setup();
    await recipes.save(USER_ID, 2, recipe);

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.body.videos['Low heat cooking']).toEqual({ videoId: 'heat001' });
    expect(recipes.getAll()[0].videos).not.toBeNull();
  });

  it('video failures never break the recipe', async () => {
    const { app } = setup({ search: { search: vi.fn().mockRejectedValue(new Error('403 quotaExceeded')) } });

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.recipe.title).toBe('Scrambled Eggs');
    expect(res.body.videos).toEqual({});
  });

  it('a failed search is not stored as "no video": the next load of the cached recipe searches again (S1)', async () => {
    const search: VideoSearchClient = {
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error('YouTube search failed: 403 quotaExceeded'))
        .mockImplementation((q: string) => Promise.resolve({ videoId: q.includes('whisk') ? 'whisk01' : 'heat001' })),
    };
    const { app, recipes } = setup({ search });

    const first = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    // One technique failed, the other was found and returned...
    expect(Object.keys(first.body.videos as Record<string, unknown>)).toHaveLength(1);
    // ...but nothing is stored with the recipe, so it isn't final.
    expect(recipes.getAll()[0].videos).toBeNull();

    const second = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);

    expect(second.body.cached).toBe(true);
    expect(second.body.videos).toEqual({
      'Whisk eggs': { videoId: 'whisk01' },
      'Low heat cooking': { videoId: 'heat001' },
    });
    expect(recipes.getAll()[0].videos).toEqual(second.body.videos);
    // 2 searches on the first load, then only the failed one again (the other is in the shared cache).
    expect(search.search).toHaveBeenCalledTimes(3);

    // Once stored, later loads don't search at all.
    await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(search.search).toHaveBeenCalledTimes(3);
  });

  it('a genuine "no result" is stored, so the recipe is not searched again on every load', async () => {
    const search: VideoSearchClient = { search: vi.fn().mockResolvedValue(null) };
    const { app, recipes } = setup({ search });

    await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(recipes.getAll()[0].videos).toEqual({});

    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(res.body.videos).toEqual({});
    expect(search.search).toHaveBeenCalledTimes(2);
  });

  it('without a YouTube key there is no video lookup and videos is empty', async () => {
    const { app } = setup({ search: null });
    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toEqual({});
  });
});

describe('F2 gating order', () => {
  it('an unknown slot is 404, not SLOT_LOCKED', async () => {
    const { app } = setup({
      pathRepository: pathRepo({
        getPathSlot: vi.fn().mockResolvedValue(null),
        isSlotUnlocked: vi.fn().mockResolvedValue(false),
      }),
    });
    const res = await request(app).post('/api/recipes/generate/99').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
  });
});

describe('F8 mastery: the final slot never sends hidden step text', () => {
  const finalSlot = pathRepo({
    getPathSlot: vi.fn().mockResolvedValue({ id: 10, dishName: 'Roast Chicken', techniqueFocus: 'Roasting', isFinal: true }),
  });

  it('masks non-safety steps on a fresh generation, but saves the full recipe', async () => {
    const { app, recipes } = setup({ pathRepository: finalSlot });
    const res = await request(app).post('/api/recipes/generate/10').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const steps = res.body.recipe.steps as Array<{ instruction: string; isHidden?: boolean; isSafetyStep: boolean }>;
    expect(steps.map((s) => s.isHidden ?? false)).toEqual([true, false, true]);
    expect(steps[1].instruction).toBe('Cook on low heat');
    expect(JSON.stringify(res.body)).not.toContain('Whisk the eggs');
    expect(JSON.stringify(res.body)).not.toContain('"Serve"');
    expect(recipes.getAll()[0].recipe.steps[0].instruction).toBe('Whisk the eggs');
  });

  it('masks a saved recipe too', async () => {
    const { app, recipes } = setup({ pathRepository: finalSlot });
    await recipes.save(USER_ID, 10, recipe);
    const res = await request(app).post('/api/recipes/generate/10').set('Authorization', `Bearer ${token()}`);
    expect(res.body.cached).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('Whisk the eggs');
    // Technique names stay, so the "Learn the move" videos still show.
    expect(res.body.videos).toHaveProperty('Whisk eggs');
  });

  it('does not leak a saved recipe when the path-slot lookup is empty', async () => {
    const { app, recipes } = setup({
      pathRepository: pathRepo({
        getPathSlot: vi.fn().mockResolvedValue(null),
      }),
    });
    await recipes.save(USER_ID, 10, recipe);
    const res = await request(app).post('/api/recipes/generate/10').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Whisk the eggs');
    expect(JSON.stringify(res.body)).not.toContain('"Serve"');
  });

  it('other slots are never masked', async () => {
    const { app, recipes } = setup();
    await recipes.save(USER_ID, 2, recipe);
    const res = await request(app).post('/api/recipes/generate/2').set('Authorization', `Bearer ${token()}`);
    expect(res.body.recipe.steps[0].instruction).toBe('Whisk the eggs');
  });
});
