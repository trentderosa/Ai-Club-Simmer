import { describe, it, expect, vi, afterEach } from 'vitest';
import { SupabaseGeneratedRecipeRepository } from './supabase-generated-recipe-repository.js';
import { SupabaseRestError } from '../services/supabase-rest.js';
import type { SaveGeneratedRecipeInput } from './generated-recipe-repository.js';
import type { Recipe } from '../schemas/recipe.js';
import type { DishPhoto } from '../services/dish-photo.js';

const TEST_CONFIG = {
  url: 'https://test-project.supabase.co',
  serviceRoleKey: 'test-service-role-key',
};

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const RECIPE_ID = '33333333-3333-4333-8333-333333333333';

const testRecipe: Recipe = {
  title: 'Test Carbonara',
  ingredients: [{ name: 'spaghetti', amount: '200 g' }],
  timeEstimateMinutes: 30,
  steps: [{ instruction: 'Boil the pasta', isSafetyStep: false }],
};

const validPhoto: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Carbonara.jpg',
  credit: {
    author: 'Fake Author',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Carbonara.jpg',
  },
};

const saveInput: SaveGeneratedRecipeInput = {
  userId: USER_ID,
  dishQuery: 'Spaghetti Carbonara!',
  normalizedDishName: 'spaghetti carbonara',
  recipe: testRecipe,
  stepCount: 1,
  ingredientCount: 1,
  timeEstimateMinutes: 30,
  xpValue: 25,
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECIPE_ID,
    user_id: USER_ID,
    dish_query: 'Spaghetti Carbonara!',
    normalized_dish_name: 'spaghetti carbonara',
    recipe_json: testRecipe,
    video_ids: null,
    photo_json: null,
    step_count: 1,
    ingredient_count: 1,
    time_estimate_minutes: 30,
    xp_value: 25,
    created_at: '2026-11-03T12:00:00Z',
    ...overrides,
  };
}

type MockFetch = typeof fetch & ReturnType<typeof vi.fn>;

function createMockFetch(responses: Array<{ status: number; body?: unknown }>): MockFetch {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const response = responses[callIndex++] ?? { status: 500 };
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: () => Promise.resolve(response.body === undefined ? '' : JSON.stringify(response.body)),
    });
  }) as unknown as MockFetch;
}

function call(mockFetch: MockFetch, index: number): [string, RequestInit] {
  return mockFetch.mock.calls[index] as [string, RequestInit];
}

describe('SupabaseGeneratedRecipeRepository', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('findByUserAndNormalizedName', () => {
    it('returns null when no row exists', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [] }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      expect(await repo.findByUserAndNormalizedName(USER_ID, 'spaghetti carbonara')).toBeNull();
    });

    it('maps the row to a saved recipe', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [row()] }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const result = await repo.findByUserAndNormalizedName(USER_ID, 'spaghetti carbonara');

      expect(result).toMatchObject({
        id: RECIPE_ID,
        userId: USER_ID,
        dishQuery: 'Spaghetti Carbonara!',
        normalizedDishName: 'spaghetti carbonara',
        recipe: testRecipe,
        videos: null,
        photo: null,
        stepCount: 1,
        ingredientCount: 1,
        timeEstimateMinutes: 30,
        xpValue: 25,
      });
      expect(result?.createdAt).toEqual(new Date('2026-11-03T12:00:00Z'));
    });

    it('scopes the GET to the user and normalized name with the service-role headers', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await repo.findByUserAndNormalizedName(USER_ID, 'spaghetti carbonara');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = call(mockFetch, 0);
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        'https://test-project.supabase.co/rest/v1/user_generated_recipes'
      );
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(parsed.searchParams.get('normalized_dish_name')).toBe('eq.spaghetti carbonara');
      expect(parsed.searchParams.get('limit')).toBe('1');
      expect(init.method).toBe('GET');
      expect(init.headers).toMatchObject({
        apikey: TEST_CONFIG.serviceRoleKey,
        Authorization: `Bearer ${TEST_CONFIG.serviceRoleKey}`,
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('parses stored videos and drops malformed ones to an empty map', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [row({ video_ids: { 'Boil pasta': { videoId: 'abc123' } } })] },
        { status: 200, body: [row({ video_ids: { 'Boil pasta': 'not-an-object' } })] },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const good = await repo.findByUserAndNormalizedName(USER_ID, 'x');
      const bad = await repo.findByUserAndNormalizedName(USER_ID, 'x');

      expect(good?.videos).toEqual({ 'Boil pasta': { videoId: 'abc123' } });
      expect(bad?.videos).toEqual({});
    });

    it('returns a stored photo only when its URLs are on the allow-list', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [row({ photo_json: validPhoto })] },
        { status: 200, body: [row({ photo_json: { ...validPhoto, url: 'https://evil.invalid/a.jpg' } })] },
        {
          status: 200,
          body: [
            row({
              photo_json: {
                ...validPhoto,
                credit: { ...validPhoto.credit, sourceUrl: 'https://evil.invalid/wiki/File:A.jpg' },
              },
            }),
          ],
        },
        { status: 200, body: [row({ photo_json: { url: 'bad-shape' } })] },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      expect((await repo.findByUserAndNormalizedName(USER_ID, 'a'))?.photo).toEqual(validPhoto);
      expect((await repo.findByUserAndNormalizedName(USER_ID, 'a'))?.photo).toBeNull();
      expect((await repo.findByUserAndNormalizedName(USER_ID, 'a'))?.photo).toBeNull();
      expect((await repo.findByUserAndNormalizedName(USER_ID, 'a'))?.photo).toBeNull();
    });

    it('throws when the stored recipe_json is invalid', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [row({ recipe_json: { title: 'x' } })] }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.findByUserAndNormalizedName(USER_ID, 'x')).rejects.toThrow(
        /Invalid generated recipe data from database/
      );
    });

    it('throws a SupabaseRestError with the status on a non-OK response', async () => {
      globalThis.fetch = createMockFetch([{ status: 500, body: { message: 'boom' } }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const error = await repo.findByUserAndNormalizedName(USER_ID, 'x').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).status).toBe(500);
      expect((error as Error).message).toContain('select user_generated_recipes failed: 500');
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
    });
  });

  describe('findByIdForUser', () => {
    it('filters by both id and user_id so another user cannot read the row', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const result = await repo.findByIdForUser(OTHER_USER_ID, RECIPE_ID);

      expect(result).toBeNull();
      const parsed = new URL(call(mockFetch, 0)[0]);
      expect(parsed.pathname).toBe('/rest/v1/user_generated_recipes');
      expect(parsed.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${OTHER_USER_ID}`);
      expect(parsed.searchParams.get('limit')).toBe('1');
    });

    it('returns the recipe for the owner', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [row()] }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const result = await repo.findByIdForUser(USER_ID, RECIPE_ID);

      expect(result?.id).toBe(RECIPE_ID);
      expect(result?.recipe).toEqual(testRecipe);
    });

    it('throws on a non-OK response', async () => {
      globalThis.fetch = createMockFetch([{ status: 503, body: 'unavailable' }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.findByIdForUser(USER_ID, RECIPE_ID)).rejects.toThrow(/failed: 503/);
    });
  });

  describe('save', () => {
    it('looks up the dish for the owner, then POSTs the insert body', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: [] },
        { status: 201, body: [row()] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const saved = await repo.save(saveInput);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [lookupUrl] = call(mockFetch, 0);
      expect(new URL(lookupUrl).searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      const [url, init] = call(mockFetch, 1);
      expect(url).toBe('https://test-project.supabase.co/rest/v1/user_generated_recipes');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Prefer: 'return=representation' });
      expect(JSON.parse(init.body as string)).toEqual({
        user_id: USER_ID,
        dish_query: 'Spaghetti Carbonara!',
        normalized_dish_name: 'spaghetti carbonara',
        recipe_json: testRecipe,
        step_count: 1,
        ingredient_count: 1,
        time_estimate_minutes: 30,
        xp_value: 25,
      });
      expect(saved.id).toBe(RECIPE_ID);
    });

    it('returns the existing recipe without inserting (first saved recipe wins)', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: [row({ recipe_json: { ...testRecipe, title: 'First Saved' }, xp_value: 10 })] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const saved = await repo.save({ ...saveInput, xpValue: 99 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(saved.recipe.title).toBe('First Saved');
      expect(saved.xpValue).toBe(10);
    });

    // Race guard: a regression where the 409 recovery awaits its own save promise
    // would hang, so fail fast after 100ms instead.
    const neverSettles = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('save never settled')), 100);
      });

    it('returns the winner row when the insert hits a unique conflict (409)', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 409, body: 'dup' },
        { status: 200, body: [row()] },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const saved = await Promise.race([repo.save(saveInput), neverSettles()]);

      expect(saved.id).toBe(RECIPE_ID);
    });

    it('rethrows the 409 when the conflicting row cannot be found', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 409, body: 'dup' },
        { status: 200, body: [] },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const error = await Promise.race([repo.save(saveInput), neverSettles()]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).status).toBe(409);
    });

    it('shares the first save result with a concurrent save issued during 409 recovery', async () => {
      const calls: string[] = [];
      let releaseRecovery: () => void = () => {};
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let gets = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        calls.push(init.method ?? 'GET');
        if (init.method === 'POST') return new Response('dup', { status: 409 });
        gets++;
        if (gets === 1) return new Response(JSON.stringify([]), { status: 200 });
        await recoveryGate;
        return new Response(JSON.stringify([row()]), { status: 200 });
      }) as unknown as typeof fetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const first = repo.save(saveInput);
      await vi.waitFor(() => expect(gets).toBe(2));
      const second = repo.save(saveInput);
      releaseRecovery();

      const [a, b] = await Promise.race([Promise.all([first, second]), neverSettles()]);

      expect(a.id).toBe(RECIPE_ID);
      expect(b).toBe(a);
      expect(calls.filter((m) => m === 'POST')).toHaveLength(1);
      expect(calls.filter((m) => m === 'GET')).toHaveLength(2);
    });

    it('makes a public find during 409 recovery wait for the save and return its result', async () => {
      let releaseRecovery: () => void = () => {};
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let gets = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return new Response('dup', { status: 409 });
        gets++;
        if (gets === 1) return new Response(JSON.stringify([]), { status: 200 });
        await recoveryGate;
        return new Response(JSON.stringify([row()]), { status: 200 });
      }) as unknown as typeof fetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const saving = repo.save(saveInput);
      await vi.waitFor(() => expect(gets).toBe(2));
      const finding = repo.findByUserAndNormalizedName(saveInput.userId, saveInput.normalizedDishName);
      releaseRecovery();

      const [saved, found] = await Promise.race([Promise.all([saving, finding]), neverSettles()]);

      expect(found).toBe(saved);
      expect(gets).toBe(2);
    });

    it('does not swallow non-409 insert errors', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 400, body: 'bad' },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.save(saveInput)).rejects.toThrow(/insert user_generated_recipes failed: 400/);
    });

    it('throws when the insert returns no row', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 201, body: [] },
      ]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.save(saveInput)).rejects.toThrow('insert user_generated_recipes returned no row');
    });

    it('dedupes concurrent saves for the same user and dish into one lookup and one insert', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        calls++;
        const isPost = init.method === 'POST';
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: isPost ? 201 : 200,
              text: () => Promise.resolve(JSON.stringify(isPost ? [row()] : [])),
            });
          }, 20);
        });
      }) as unknown as typeof fetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      const results = await Promise.all([repo.save(saveInput), repo.save(saveInput), repo.save(saveInput)]);

      expect(calls).toBe(2);
      results.forEach((r) => expect(r.id).toBe(RECIPE_ID));
    });

    it('does not dedupe saves for different users with the same dish', async () => {
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const isPost = init.method === 'POST';
        return Promise.resolve({
          ok: true,
          status: isPost ? 201 : 200,
          text: () => Promise.resolve(JSON.stringify(isPost ? [row()] : [])),
        });
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await Promise.all([repo.save(saveInput), repo.save({ ...saveInput, userId: OTHER_USER_ID })]);

      const posts = mockFetch.mock.calls.filter((c) => (c[1] as RequestInit).method === 'POST');
      expect(posts).toHaveLength(2);
    });

    it('clears the in-flight entry after a failure so a later save retries', async () => {
      const mockFetch = createMockFetch([
        { status: 500, body: 'down' },
        { status: 200, body: [] },
        { status: 201, body: [row()] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.save(saveInput)).rejects.toThrow(/failed: 500/);
      const saved = await repo.save(saveInput);

      expect(saved.id).toBe(RECIPE_ID);
    });

    it('times out a hung request without leaking the key', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as typeof fetch;
      const repo = new SupabaseGeneratedRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });

      const error = await repo.save(saveInput).catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
      expect((error as Error).message).toBe('Supabase generated recipe select user_generated_recipes timed out after 20ms');
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
    });
  });

  describe('saveVideos', () => {
    it('PATCHes video_ids for the owner and id with return=minimal', async () => {
      const mockFetch = createMockFetch([{ status: 204 }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await repo.saveVideos(USER_ID, RECIPE_ID, { 'Boil pasta': { videoId: 'abc123' } });

      const [url, init] = call(mockFetch, 0);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/rest/v1/user_generated_recipes');
      expect(parsed.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(init.method).toBe('PATCH');
      expect(init.headers).toMatchObject({ Prefer: 'return=minimal' });
      expect(JSON.parse(init.body as string)).toEqual({ video_ids: { 'Boil pasta': { videoId: 'abc123' } } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('throws on a non-OK response', async () => {
      globalThis.fetch = createMockFetch([{ status: 500, body: { message: 'boom' } }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.saveVideos(USER_ID, RECIPE_ID, {})).rejects.toThrow(
        /update user_generated_recipes.video_ids failed: 500/
      );
    });
  });

  describe('savePhoto', () => {
    it('PATCHes photo_json for the owner and id with return=minimal', async () => {
      const mockFetch = createMockFetch([{ status: 204 }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await repo.savePhoto(USER_ID, RECIPE_ID, validPhoto);

      const [url, init] = call(mockFetch, 0);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(init.method).toBe('PATCH');
      expect(init.headers).toMatchObject({ Prefer: 'return=minimal' });
      expect(JSON.parse(init.body as string)).toEqual({ photo_json: validPhoto });
    });

    it('throws on a non-OK response', async () => {
      globalThis.fetch = createMockFetch([{ status: 404, body: 'nope' }]);
      const repo = new SupabaseGeneratedRecipeRepository(TEST_CONFIG);

      await expect(repo.savePhoto(USER_ID, RECIPE_ID, validPhoto)).rejects.toThrow(
        /update user_generated_recipes.photo_json failed: 404/
      );
    });
  });

  describe('request timeouts', () => {
    const hangUntilAborted = (): MockFetch =>
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      ) as unknown as MockFetch;

    const hangingBody = (): MockFetch =>
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              }),
          })
      ) as unknown as MockFetch;

    it('passes an AbortSignal to fetch', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = mockFetch;
      await new SupabaseGeneratedRecipeRepository(TEST_CONFIG).findByIdForUser(USER_ID, RECIPE_ID);
      expect(call(mockFetch, 0)[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects with a timeout SupabaseRestError when fetch hangs', async () => {
      globalThis.fetch = hangUntilAborted();
      const repo = new SupabaseGeneratedRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.findByIdForUser(USER_ID, RECIPE_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
      expect((error as SupabaseRestError).message).toBe('Supabase generated recipe select user_generated_recipes timed out after 20ms');
    });

    it('rejects with a timeout SupabaseRestError when the body never arrives', async () => {
      globalThis.fetch = hangingBody();
      const repo = new SupabaseGeneratedRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.findByIdForUser(USER_ID, RECIPE_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
    });
  });
});
