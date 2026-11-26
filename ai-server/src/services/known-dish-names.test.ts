import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectKnownDishNames, SupabaseKnownDishNames } from './known-dish-names.js';

describe('collectKnownDishNames', () => {
  it('normalizes path and generated names and drops blanks', () => {
    expect(
      collectKnownDishNames(['  Pho  ', 'Chicken Parmesan', ''], ['PAD THAI', '   '])
    ).toEqual(new Set(['pho', 'chicken parmesan', 'pad thai']));
  });
});

describe('SupabaseKnownDishNames', () => {
  const USER = '550e8400-e29b-41d4-a716-446655440000';
  const mockFetch = vi.fn();
  const ok = (body: unknown): unknown => ({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
  const missing = (): unknown => ({
    ok: false,
    status: 404,
    text: () => Promise.resolve(JSON.stringify({ code: 'PGRST205', message: 'secret-body-text' })),
  });
  let names: SupabaseKnownDishNames;
  let logger: { warn: ReturnType<typeof vi.fn> };

  /** Answer by table so the parallel reads can run in any order. */
  function route(tables: Record<string, () => unknown>): void {
    mockFetch.mockImplementation((url: string) => {
      const table = new URL(url).pathname.split('/').pop() ?? '';
      return Promise.resolve(tables[table]?.() ?? ok([]));
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    logger = { warn: vi.fn() };
    names = new SupabaseKnownDishNames({ url: 'https://test-project.supabase.co', serviceRoleKey: 'k', timeoutMs: 1000 }, logger);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes canonical, catalog, the user dishes and generated names', async () => {
    route({
      path_slots: () => ok([{ dish_name: 'Roast Chicken' }]),
      dish_catalog: () => ok([{ dish_name: 'Mapo Tofu' }]),
      user_path_dishes: () => ok([{ dish_name: 'Chicken Tikka' }]),
      user_generated_recipes: () => ok([{ normalized_dish_name: 'pad thai' }]),
    });
    expect(await names.listForUser(USER)).toEqual(new Set(['roast chicken', 'mapo tofu', 'chicken tikka', 'pad thai']));
    const userDishCall = mockFetch.mock.calls.map((c) => new URL((c as [string])[0])).find((u) => u.pathname.endsWith('user_path_dishes'));
    expect(userDishCall?.searchParams.get('user_id')).toBe(`eq.${USER}`);
  });

  it('works without dish_catalog and user_path_dishes, and remembers they are missing', async () => {
    route({
      path_slots: () => ok([{ dish_name: 'Roast Chicken' }]),
      dish_catalog: missing,
      user_path_dishes: missing,
    });
    expect(await names.listForUser(USER)).toEqual(new Set(['roast chicken']));
    const callsAfterFirst = mockFetch.mock.calls.length;
    expect(await names.listForUser(USER)).toEqual(new Set(['roast chicken']));
    // Second call: only path_slots and user_generated_recipes.
    expect(mockFetch.mock.calls.length - callsAfterFirst).toBe(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-body-text');
  });
});
