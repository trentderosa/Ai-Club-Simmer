import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInIdempotencyConflict } from '../types/check-in.js';
import { SupabaseRestError } from '../services/supabase-rest.js';
import { SupabaseGeneratedCheckInRepository } from './supabase-generated-check-in-repository.js';

const TEST_CONFIG = {
  url: 'https://test-project.supabase.co',
  serviceRoleKey: 'test-service-role-key',
};

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const RECIPE_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    user_id: USER_ID,
    generated_recipe_id: RECIPE_ID,
    difficulty_rating: 'ok',
    went_well: 'Sauce was great',
    was_hard: null,
    is_repeat: false,
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

const baseParams = {
  user_id: USER_ID,
  generated_recipe_id: RECIPE_ID,
  difficulty_rating: 'ok' as const,
  went_well: 'Sauce was great',
  was_hard: null,
};

describe('SupabaseGeneratedCheckInRepository', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('validateRecipe', () => {
    it('filters by id and user_id and returns true when a row exists', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [{ id: RECIPE_ID }] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      expect(await repo.validateRecipe(USER_ID, RECIPE_ID)).toBe(true);

      const [url, init] = call(mockFetch, 0);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/rest/v1/user_generated_recipes');
      expect(parsed.searchParams.get('select')).toBe('id');
      expect(parsed.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(parsed.searchParams.get('limit')).toBe('1');
      expect(init.headers).toMatchObject({
        apikey: TEST_CONFIG.serviceRoleKey,
        Authorization: `Bearer ${TEST_CONFIG.serviceRoleKey}`,
      });
    });

    it('returns false when the recipe is not found for that user', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      expect(await repo.validateRecipe(OTHER_USER_ID, RECIPE_ID)).toBe(false);
      expect(new URL(call(mockFetch, 0)[0]).searchParams.get('user_id')).toBe(`eq.${OTHER_USER_ID}`);
    });

    it('throws on a database error instead of returning false', async () => {
      globalThis.fetch = createMockFetch([{ status: 500, body: 'boom' }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const error = await repo.validateRecipe(USER_ID, RECIPE_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as Error).message).toContain('validate generated recipe failed: 500');
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
    });
  });

  describe('getDishName', () => {
    it('selects dish_query scoped to the owner and returns it', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: [{ dish_query: 'Spaghetti Carbonara' }] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      expect(await repo.getDishName(USER_ID, RECIPE_ID)).toBe('Spaghetti Carbonara');

      const parsed = new URL(call(mockFetch, 0)[0]);
      expect(parsed.pathname).toBe('/rest/v1/user_generated_recipes');
      expect(parsed.searchParams.get('select')).toBe('dish_query');
      expect(parsed.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);
      expect(parsed.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
    });

    it('returns null when not found, blank, or not a string', async () => {
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 200, body: [{ dish_query: '   ' }] },
        { status: 200, body: [{ dish_query: 42 }] },
        { status: 200, body: [{}] },
      ]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      expect(await repo.getDishName(USER_ID, RECIPE_ID)).toBeNull();
      expect(await repo.getDishName(USER_ID, RECIPE_ID)).toBeNull();
      expect(await repo.getDishName(USER_ID, RECIPE_ID)).toBeNull();
      expect(await repo.getDishName(USER_ID, RECIPE_ID)).toBeNull();
    });

    it('throws on a database error', async () => {
      globalThis.fetch = createMockFetch([{ status: 502, body: 'bad gateway' }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.getDishName(USER_ID, RECIPE_ID)).rejects.toThrow(
        'select generated recipe dish failed: 502'
      );
    });
  });

  describe('create without a client id', () => {
    it('POSTs the insert body (no id) in a single request and returns created: true', async () => {
      const inserted = row();
      const mockFetch = createMockFetch([{ status: 201, body: [inserted] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const result = await repo.create(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = call(mockFetch, 0);
      expect(url).toBe('https://test-project.supabase.co/rest/v1/generated_recipe_check_ins');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Prefer: 'return=representation' });
      expect(JSON.parse(init.body as string)).toEqual({
        user_id: USER_ID,
        generated_recipe_id: RECIPE_ID,
        difficulty_rating: 'ok',
        went_well: 'Sauce was great',
        was_hard: null,
      });
      expect(result).toMatchObject({
        id: inserted.id,
        user_id: USER_ID,
        generated_recipe_id: RECIPE_ID,
        difficulty_rating: 'ok',
        went_well: 'Sauce was great',
        was_hard: null,
        is_repeat: false,
        created: true,
      });
      expect(result.created_at).toEqual(new Date('2026-11-03T12:00:00Z'));
    });

    it('throws when the insert returns no row', async () => {
      globalThis.fetch = createMockFetch([{ status: 201, body: [] }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create(baseParams)).rejects.toThrow(
        'insert generated_recipe_check_ins returned no row'
      );
    });

    it('rethrows a 409 as a SupabaseRestError without retrying or leaking the key', async () => {
      const mockFetch = createMockFetch([{ status: 409, body: 'duplicate' }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const error = await repo.create(baseParams).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).status).toBe(409);
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces other insert errors', async () => {
      globalThis.fetch = createMockFetch([{ status: 400, body: 'constraint' }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create(baseParams)).rejects.toThrow(/insert generated_recipe_check_ins failed: 400/);
    });
  });

  describe('create with an idempotency id', () => {
    it('looks up the id first, then inserts it when absent', async () => {
      const id = randomUUID();
      const mockFetch = createMockFetch([
        { status: 200, body: [] },
        { status: 201, body: [row({ id })] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const result = await repo.create({ ...baseParams, id });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const lookup = new URL(call(mockFetch, 0)[0]);
      expect(lookup.pathname).toBe('/rest/v1/generated_recipe_check_ins');
      expect(lookup.searchParams.get('id')).toBe(`eq.${id}`);
      expect(call(mockFetch, 0)[1].method).toBe('GET');
      expect(JSON.parse(call(mockFetch, 1)[1].body as string).id).toBe(id);
      expect(result.id).toBe(id);
      expect(result.created).toBe(true);
    });

    it('returns the existing check-in (created: false) without inserting on a replay', async () => {
      const id = randomUUID();
      const mockFetch = createMockFetch([
        { status: 200, body: [row({ id, went_well: 'first write', difficulty_rating: 'easy' })] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const result = await repo.create({ ...baseParams, id, went_well: 'retry', difficulty_rating: 'hard' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(false);
      expect(result.went_well).toBe('first write');
      expect(result.difficulty_rating).toBe('easy');
    });

    it('throws CheckInIdempotencyConflict when the id belongs to another user', async () => {
      const id = randomUUID();
      const mockFetch = createMockFetch([{ status: 200, body: [row({ id, user_id: OTHER_USER_ID })] }]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create({ ...baseParams, id })).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws CheckInIdempotencyConflict when the id belongs to a different recipe', async () => {
      const id = randomUUID();
      globalThis.fetch = createMockFetch([{ status: 200, body: [row({ id, generated_recipe_id: randomUUID() })] }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create({ ...baseParams, id })).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
    });

    it('returns the winner when the insert races and hits 409 for the same check-in', async () => {
      const id = randomUUID();
      const mockFetch = createMockFetch([
        { status: 200, body: [] },
        { status: 409, body: 'duplicate key' },
        { status: 200, body: [row({ id, went_well: 'winner' })] },
      ]);
      globalThis.fetch = mockFetch;
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      const result = await repo.create({ ...baseParams, id });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.created).toBe(false);
      expect(result.went_well).toBe('winner');
    });

    it('throws CheckInIdempotencyConflict when a 409 row belongs to someone else', async () => {
      const id = randomUUID();
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 409, body: 'duplicate key' },
        { status: 200, body: [row({ id, user_id: OTHER_USER_ID })] },
      ]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create({ ...baseParams, id })).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
    });

    it('throws CheckInIdempotencyConflict when a 409 finds no row at all', async () => {
      const id = randomUUID();
      globalThis.fetch = createMockFetch([
        { status: 200, body: [] },
        { status: 409, body: 'duplicate key' },
        { status: 200, body: [] },
      ]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create({ ...baseParams, id })).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
    });

    it('propagates a lookup failure', async () => {
      globalThis.fetch = createMockFetch([{ status: 500, body: 'boom' }]);
      const repo = new SupabaseGeneratedCheckInRepository(TEST_CONFIG);

      await expect(repo.create({ ...baseParams, id: randomUUID() })).rejects.toThrow(
        /select generated_recipe_check_ins failed: 500/
      );
    });
  });

  describe('timeouts', () => {
    it('aborts a hung request and the error does not contain the key', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as typeof fetch;
      const repo = new SupabaseGeneratedCheckInRepository({ ...TEST_CONFIG, timeoutMs: 20 });

      const error = await repo.validateRecipe(USER_ID, RECIPE_ID).catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(TEST_CONFIG.serviceRoleKey);
    });
  });
});
