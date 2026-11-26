import { describe, it, expect, vi, afterEach } from 'vitest';
import { SupabaseUserRecipeRepository } from './supabase-user-recipe-repository.js';
import { SupabaseRestError } from '../services/supabase-rest.js';
import type { Recipe } from '../schemas/recipe.js';

const TEST_CONFIG = {
  url: 'https://test-project.supabase.co',
  serviceRoleKey: 'test-service-role-key',
};

const testRecipe: Recipe = {
  title: 'Test Recipe',
  ingredients: [{ name: 'ingredient', amount: '1 cup' }],
  timeEstimateMinutes: 30,
  steps: [{ instruction: 'Test step', isSafetyStep: false }],
};

const mockDbRow = {
  id: 'recipe-uuid-123',
  user_id: 'user-123',
  slot_id: 1,
  recipe_json: testRecipe,
  created_at: '2026-11-03T12:00:00Z',
};

function createMockFetch(
  responses: Array<{ status: number; body?: unknown }>
): typeof fetch {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const response = responses[callIndex++] ?? { status: 500 };
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body ?? []),
      text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
    });
  });
}

describe('SupabaseUserRecipeRepository', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('findByUserAndSlot', () => {
    it('returns null when no recipe exists', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [] }]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const result = await repo.findByUserAndSlot('user-123', 1);

      expect(result).toBeNull();
    });

    it('returns the recipe when it exists', async () => {
      globalThis.fetch = createMockFetch([{ status: 200, body: [mockDbRow] }]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const result = await repo.findByUserAndSlot('user-123', 1);

      expect(result).not.toBeNull();
      expect(result?.recipe).toEqual(testRecipe);
      expect(result?.userId).toBe('user-123');
      expect(result?.slotId).toBe(1);
    });

    it('sends correct PostgREST eq. filters', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await repo.findByUserAndSlot('user-abc', 5);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(url.searchParams.get('user_id')).toBe('eq.user-abc');
      expect(url.searchParams.get('slot_id')).toBe('eq.5');
    });

    it('throws on non-OK response', async () => {
      globalThis.fetch = createMockFetch([
        { status: 500, body: { message: 'Internal Server Error' } },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await expect(repo.findByUserAndSlot('user-123', 1)).rejects.toThrow(
        'Supabase query failed: 500'
      );
    });

    it('throws on invalid recipe_json schema', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [{ ...mockDbRow, recipe_json: { invalid: true } }] },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await expect(repo.findByUserAndSlot('user-123', 1)).rejects.toThrow(
        'Invalid recipe data from database'
      );
    });
  });

  describe('save', () => {
    it('returns saved recipe on successful 201 insert', async () => {
      globalThis.fetch = createMockFetch([{ status: 201, body: [mockDbRow] }]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const result = await repo.save('user-123', 1, testRecipe);

      expect(result.recipe).toEqual(testRecipe);
      expect(result.id).toBe('recipe-uuid-123');
    });

    it('sends on_conflict parameter in URL', async () => {
      const mockFetch = createMockFetch([{ status: 201, body: [mockDbRow] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await repo.save('user-123', 1, testRecipe);

      const url = new URL((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(url.searchParams.get('on_conflict')).toBe('user_id,slot_id');
    });

    it('sends correct Prefer header for ignore-duplicates', async () => {
      const mockFetch = createMockFetch([{ status: 201, body: [mockDbRow] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await repo.save('user-123', 1, testRecipe);

      const options = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(options.headers).toHaveProperty(
        'Prefer',
        'return=representation,resolution=ignore-duplicates'
      );
    });

    it('on 409 conflict, fetches existing row without deadlock', async () => {
      globalThis.fetch = createMockFetch([
        { status: 409, body: { message: 'conflict' } },
        { status: 200, body: [mockDbRow] },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const result = await repo.save('user-123', 1, testRecipe);

      expect(result.recipe).toEqual(testRecipe);
      expect(result.id).toBe('recipe-uuid-123');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('on empty insert response (ignore-duplicates), fetches existing row', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 200, body: [mockDbRow] },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const result = await repo.save('user-123', 1, testRecipe);

      expect(result.recipe).toEqual(testRecipe);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws on 409 when no existing row found', async () => {
      globalThis.fetch = createMockFetch([
        { status: 409, body: { message: 'conflict' } },
        { status: 200, body: [] },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await expect(repo.save('user-123', 1, testRecipe)).rejects.toThrow(
        'Conflict but no existing record found'
      );
    });

    it('throws on non-OK response other than 409', async () => {
      globalThis.fetch = createMockFetch([
        { status: 500, body: { message: 'Internal Server Error' } },
      ]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await expect(repo.save('user-123', 1, testRecipe)).rejects.toThrow(
        'Supabase insert failed: 500'
      );
    });

    it('deduplicates concurrent saves for same user+slot', async () => {
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 201,
              json: () => Promise.resolve([mockDbRow]),
              text: () => Promise.resolve(''),
            });
          }, 50);
        });
      });

      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      const results = await Promise.all([
        repo.save('user-123', 1, testRecipe),
        repo.save('user-123', 1, testRecipe),
        repo.save('user-123', 1, testRecipe),
      ]);

      expect(fetchCallCount).toBe(1);
      results.forEach((result) => {
        expect(result.id).toBe('recipe-uuid-123');
      });
    });
  });

  describe('saveVideos', () => {
    it('PATCHes video_ids for the user and slot with an abort signal', async () => {
      const mockFetch = createMockFetch([{ status: 204 }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await repo.saveVideos('user-123', 2, { 'Whisk eggs': { videoId: 'whisk01' } });

      const [url, init] = vi.mocked(mockFetch).mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/rest/v1/user_recipes');
      expect(parsed.searchParams.get('user_id')).toBe('eq.user-123');
      expect(parsed.searchParams.get('slot_id')).toBe('eq.2');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ video_ids: { 'Whisk eggs': { videoId: 'whisk01' } } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('throws on a non-OK response', async () => {
      globalThis.fetch = createMockFetch([{ status: 500, body: { message: 'boom' } }]);
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);
      await expect(repo.saveVideos('user-123', 2, {})).rejects.toThrow(/video update failed: 500/);
    });

    it('times out a hung request without leaking the key (N1)', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const repo = new SupabaseUserRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.saveVideos('user-123', 2, {}).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Supabase video update timed out after 20ms');
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
    });
  });

  describe('request timeouts', () => {
    const hangUntilAborted = (): typeof fetch =>
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

    it('passes an AbortSignal on read and insert requests', async () => {
      const fetchMock = createMockFetch([
        { status: 200, body: [] },
        { status: 201, body: [mockDbRow] },
      ]);
      globalThis.fetch = fetchMock;
      const repo = new SupabaseUserRecipeRepository(TEST_CONFIG);

      await repo.findByUserAndSlot('user-123', 1);
      await repo.save('user-123', 1, testRecipe);

      const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
      expect(calls).toHaveLength(2);
      for (const [, init] of calls) {
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('times out a hung read with a SupabaseRestError', async () => {
      globalThis.fetch = hangUntilAborted();
      const repo = new SupabaseUserRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.findByUserAndSlot('user-123', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
      expect((error as SupabaseRestError).message).toBe('Supabase recipe query timed out after 20ms');
    });

    it('times out a hung insert with a SupabaseRestError', async () => {
      globalThis.fetch = hangUntilAborted();
      const repo = new SupabaseUserRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.save('user-123', 1, testRecipe).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
      expect((error as SupabaseRestError).message).toBe('Supabase recipe insert timed out after 20ms');
    });

    it('times out when the response body never arrives', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          })
      );
      const repo = new SupabaseUserRecipeRepository({ ...TEST_CONFIG, timeoutMs: 20 });
      const error = await repo.findByUserAndSlot('user-123', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
    });
  });
});
