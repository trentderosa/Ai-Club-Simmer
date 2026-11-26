import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabasePathRepository, normalizeEquipment } from './path-repository.js';

const KEY = 'test-service-role-key';
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const mockFetch = vi.fn();

function ok(body: unknown): { ok: true; text: () => Promise<string> } {
  return { ok: true, text: () => Promise.resolve(JSON.stringify(body)) };
}

function fail(status: number, body: string): { ok: false; status: number; text: () => Promise<string> } {
  return { ok: false, status, text: () => Promise.resolve(body) };
}

function calledUrl(n = 0): URL {
  return new URL((mockFetch.mock.calls[n] as [string])[0]);
}

describe('SupabasePathRepository', () => {
  let repo: SupabasePathRepository;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    repo = new SupabasePathRepository({ url: 'https://test-project.supabase.co', serviceRoleKey: KEY, timeoutMs: 1000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getPathSlot', () => {
    it('reads the slot with the service role', async () => {
      mockFetch.mockResolvedValueOnce(
        ok([{ id: 10, dish_name: 'Roast Chicken', technique_focus: 'Complete meal execution', is_final: true }])
      );
      mockFetch.mockResolvedValueOnce(ok([])); // user_path_dishes: no override

      const slot = await repo.getPathSlot(10, USER_ID);

      expect(slot).toEqual({ id: 10, dishName: 'Roast Chicken', techniqueFocus: 'Complete meal execution', isFinal: true });
      const url = calledUrl();
      expect(url.pathname).toBe('/rest/v1/path_slots');
      expect(url.searchParams.get('id')).toBe('eq.10');
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('returns null for an unknown slot', async () => {
      mockFetch.mockResolvedValueOnce(ok([]));
      expect(await repo.getPathSlot(99, USER_ID)).toBeNull();
    });
  });

  describe('getNextPathSlot', () => {
    it('finds the next slot by slot_order, not by id', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([{ slot_order: 4 }]))
        .mockResolvedValueOnce(
          ok([{ id: 41, dish_name: 'Pasta', technique_focus: 'Boiling', is_final: false }])
        )
        .mockResolvedValueOnce(ok([])); // user_path_dishes: no override
      const slot = await repo.getNextPathSlot(37, USER_ID);
      expect(slot).toEqual({ id: 41, dishName: 'Pasta', techniqueFocus: 'Boiling', isFinal: false });
      expect(calledUrl(0).searchParams.get('id')).toBe('eq.37');
      expect(calledUrl(1).searchParams.get('slot_order')).toBe('gt.4');
      expect(calledUrl(1).searchParams.get('order')).toBe('slot_order.asc');
      expect(calledUrl(1).searchParams.get('limit')).toBe('1');
    });

    it('skips a gap in slot_order (3 to 5) by taking the next higher slot', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([{ slot_order: 3 }]))
        .mockResolvedValueOnce(
          ok([{ id: 55, dish_name: 'Soup', technique_focus: 'Simmering', is_final: false }])
        )
        .mockResolvedValueOnce(ok([])); // user_path_dishes: no override
      const slot = await repo.getNextPathSlot(33, USER_ID);
      expect(slot?.id).toBe(55);
      expect(calledUrl(1).searchParams.get('slot_order')).toBe('gt.3');
    });

    it('returns null after the last slot or for an unknown slot', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ slot_order: 10 }])).mockResolvedValueOnce(ok([]));
      expect(await repo.getNextPathSlot(50, USER_ID)).toBeNull();
      mockFetch.mockResolvedValueOnce(ok([]));
      expect(await repo.getNextPathSlot(999, USER_ID)).toBeNull();
    });
  });

  describe('getEquipment', () => {
    it('reads only the equipment column and normalizes it', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ equipment: [' stove ', 'Oven', 'oven', ''] }]));
      expect(await repo.getEquipment(USER_ID)).toEqual(['stove', 'Oven']);
      const url = calledUrl();
      expect(url.pathname).toBe('/rest/v1/profiles');
      expect(url.searchParams.get('select')).toBe('equipment');
      expect(url.searchParams.get('id')).toBe(`eq.${USER_ID}`);
    });

    it('returns an empty list for a missing profile or null equipment', async () => {
      mockFetch.mockResolvedValueOnce(ok([]));
      expect(await repo.getEquipment(USER_ID)).toEqual([]);
      mockFetch.mockResolvedValueOnce(ok([{ equipment: null }]));
      expect(await repo.getEquipment(USER_ID)).toEqual([]);
    });
  });

  describe('getUserProfile', () => {
    const profileRow = {
      id: USER_ID,
      experience_level: 'never_cooked',
      budget: 'low',
      equipment: ['stove', 'pan'],
      onboarding_completed: true,
    };

    it('maps onboarding answers and recent check-ins (oldest first) for the prompt', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([profileRow]))
        .mockResolvedValueOnce(
          ok([
            // newest first, as queried
            { difficulty_rating: 'hard', went_well: null, was_hard: 'heat control', path_slots: { dish_name: 'Scrambled Eggs' } },
            { difficulty_rating: 'easy', went_well: 'knife work', was_hard: null, path_slots: { dish_name: 'Knife Basics Salad' } },
          ])
        )
        .mockResolvedValueOnce(ok([])); // user_path_dishes: no overrides

      const profile = await repo.getUserProfile(USER_ID);

      expect(profile).toEqual({
        id: USER_ID,
        experienceLevel: 'never_cooked',
        budget: 'low',
        equipment: ['stove', 'pan'],
        recentCheckIns: [
          { recipeName: 'Knife Basics Salad', difficulty: 'easy', whatWentWell: 'knife work' },
          { recipeName: 'Scrambled Eggs', difficulty: 'hard', whatWasHard: 'heat control' },
        ],
      });
      const checkInsUrl = calledUrl(1);
      expect(checkInsUrl.pathname).toBe('/rest/v1/check_ins');
      expect(checkInsUrl.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(checkInsUrl.searchParams.get('order')).toBe('created_at.desc');
      expect(checkInsUrl.searchParams.get('limit')).toBe('3');
    });

    it('returns null when there is no profile', async () => {
      mockFetch.mockResolvedValueOnce(ok([]));
      expect(await repo.getUserProfile(USER_ID)).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns null until onboarding is finished', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ ...profileRow, onboarding_completed: false }]));
      expect(await repo.getUserProfile(USER_ID)).toBeNull();
    });

    it('treats missing equipment as an empty list', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ ...profileRow, equipment: null }])).mockResolvedValueOnce(ok([]));
      const profile = await repo.getUserProfile(USER_ID);
      expect(profile?.equipment).toEqual([]);
      expect(profile?.recentCheckIns).toEqual([]);
    });

    it('normalizes messy equipment instead of treating the user as not onboarded (N3)', async () => {
      const messy = ['  stove ', '', '   ', 'Pan', 'pan', 'x'.repeat(150), ...Array.from({ length: 60 }, (_, i) => `tool ${i}`)];
      mockFetch.mockResolvedValueOnce(ok([{ ...profileRow, equipment: messy }])).mockResolvedValueOnce(ok([]));

      const profile = await repo.getUserProfile(USER_ID);

      expect(profile).not.toBeNull();
      expect(profile?.equipment).toHaveLength(50);
      expect(profile?.equipment.slice(0, 4)).toEqual(['stove', 'Pan', 'x'.repeat(100), 'tool 0']);
    });

    it('cuts over-long check-in answers to the prompt limit', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([profileRow]))
        .mockResolvedValueOnce(
          ok([{ difficulty_rating: 'ok', went_well: 'a'.repeat(1500), was_hard: '  ', path_slots: null }])
        )
        .mockResolvedValueOnce(ok([]));
      const profile = await repo.getUserProfile(USER_ID);
      expect(profile?.recentCheckIns).toEqual([
        { recipeName: 'a previous recipe', difficulty: 'ok', whatWentWell: 'a'.repeat(1000) },
      ]);
    });

    it('logs which fields failed (paths only, no values) when the profile still does not fit', async () => {
      const logger = { warn: vi.fn() };
      repo = new SupabasePathRepository(
        { url: 'https://test-project.supabase.co', serviceRoleKey: KEY, timeoutMs: 1000 },
        logger
      );
      mockFetch
        .mockResolvedValueOnce(ok([{ ...profileRow, experience_level: 'chef-secret-value' }]))
        .mockResolvedValueOnce(ok([]));

      expect(await repo.getUserProfile(USER_ID)).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('user_profile_invalid', {
        issues: [{ path: 'experienceLevel', code: 'invalid_value' }],
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('chef-secret-value');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(USER_ID);
    });
  });

  describe('personalized dishes', () => {
    const slotRow = { id: 10, dish_name: 'Roast Chicken', technique_focus: 'Roasting', is_final: false };
    const profileRow = {
      id: USER_ID,
      experience_level: 'never_cooked',
      budget: 'low',
      equipment: ['stove'],
      onboarding_completed: true,
    };
    const missingTable = fail(404, JSON.stringify({ code: 'PGRST205', message: 'secret-body-text' }));
    const missingColumn = fail(400, JSON.stringify({ code: '42703', message: 'secret-body-text' }));

    it('getPathSlot uses the user override when present', async () => {
      mockFetch.mockResolvedValueOnce(ok([slotRow])).mockResolvedValueOnce(ok([{ slot_id: 10, dish_name: 'Chicken Tikka' }]));
      const slot = await repo.getPathSlot(10, USER_ID);
      expect(slot).toEqual({ id: 10, dishName: 'Chicken Tikka', techniqueFocus: 'Roasting', isFinal: false });
      const url = calledUrl(1);
      expect(url.pathname).toBe('/rest/v1/user_path_dishes');
      expect(url.searchParams.get('user_id')).toBe(`eq.${USER_ID}`);
      expect(url.searchParams.get('slot_id')).toBe('eq.10');
    });

    it('getNextPathSlot uses the user override for the next slot', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([{ slot_order: 3 }]))
        .mockResolvedValueOnce(ok([slotRow]))
        .mockResolvedValueOnce(ok([{ slot_id: 10, dish_name: 'Mapo Tofu' }]));
      const slot = await repo.getNextPathSlot(9, USER_ID);
      expect(slot?.dishName).toBe('Mapo Tofu');
      expect(calledUrl(2).searchParams.get('slot_id')).toBe('eq.10');
    });

    it('falls back to the canonical dish when user_path_dishes does not exist, and remembers it', async () => {
      const logger = { warn: vi.fn() };
      repo = new SupabasePathRepository({ url: 'https://test-project.supabase.co', serviceRoleKey: KEY, timeoutMs: 1000 }, logger);
      mockFetch.mockResolvedValueOnce(ok([slotRow])).mockResolvedValueOnce(missingTable).mockResolvedValueOnce(ok([slotRow]));
      expect((await repo.getPathSlot(10, USER_ID))?.dishName).toBe('Roast Chicken');
      expect((await repo.getPathSlot(10, USER_ID))?.dishName).toBe('Roast Chicken');
      // 2 path_slots reads + 1 failed user_path_dishes read: the second call skipped the table.
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-body-text');
    });

    it('retries user_path_dishes after the unavailable memo expires', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce(ok([slotRow])).mockResolvedValueOnce(missingTable);
        await repo.getPathSlot(10, USER_ID);
        vi.advanceTimersByTime(61_000);
        mockFetch.mockResolvedValueOnce(ok([slotRow])).mockResolvedValueOnce(ok([{ slot_id: 10, dish_name: 'Chicken Tikka' }]));
        expect((await repo.getPathSlot(10, USER_ID))?.dishName).toBe('Chicken Tikka');
      } finally {
        vi.useRealTimers();
      }
    });

    it('maps dietary_needs to prompt phrases and drops unknown values', async () => {
      mockFetch.mockResolvedValueOnce(
        ok([{ ...profileRow, dietary_needs: ['vegan', 'nut_free', 'dairy_free', 'gluten_free', 'no_spicy', 'no_pork', 'egg_free', 'no_mushrooms', 'bogus'] }])
      ).mockResolvedValueOnce(ok([]));
      const profile = await repo.getUserProfile(USER_ID);
      expect(profile?.dietaryNeeds).toEqual([
        'vegan', 'no nuts (allergy)', 'dairy-free', 'gluten-free', 'not spicy', 'no pork', 'no eggs', 'no mushrooms',
      ]);
      expect(calledUrl(0).searchParams.get('select')).toContain('dietary_needs');
    });

    it('omits dietaryNeeds when the user has none', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ ...profileRow, dietary_needs: [] }])).mockResolvedValueOnce(ok([]));
      expect((await repo.getUserProfile(USER_ID))?.dietaryNeeds).toBeUndefined();
    });

    it('names recent check-ins by the user dish, else the canonical one', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([profileRow]))
        .mockResolvedValueOnce(
          ok([
            { slot_id: 2, difficulty_rating: 'ok', went_well: null, was_hard: null, path_slots: { dish_name: 'Scrambled Eggs' } },
            { slot_id: 1, difficulty_rating: 'easy', went_well: null, was_hard: null, path_slots: { dish_name: 'Knife Basics Salad' } },
          ])
        )
        .mockResolvedValueOnce(ok([{ slot_id: 1, dish_name: 'Cucumber Salad' }]));
      const profile = await repo.getUserProfile(USER_ID);
      expect(profile?.recentCheckIns?.map((c) => c.recipeName)).toEqual(['Cucumber Salad', 'Scrambled Eggs']);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(calledUrl(2).pathname).toBe('/rest/v1/user_path_dishes');
    });

    it('falls back to the old profile select when dietary_needs is missing, and remembers it', async () => {
      const logger = { warn: vi.fn() };
      repo = new SupabasePathRepository({ url: 'https://test-project.supabase.co', serviceRoleKey: KEY, timeoutMs: 1000 }, logger);
      mockFetch
        .mockResolvedValueOnce(missingColumn)
        .mockResolvedValueOnce(ok([profileRow]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([profileRow]))
        .mockResolvedValueOnce(ok([]));
      const first = await repo.getUserProfile(USER_ID);
      expect(first?.dietaryNeeds).toBeUndefined();
      expect(calledUrl(1).searchParams.get('select')).not.toContain('dietary_needs');
      await repo.getUserProfile(USER_ID);
      // Second call went straight to the old select (no new failed attempt).
      expect(calledUrl(3).searchParams.get('select')).not.toContain('dietary_needs');
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-body-text');
    });

    it('a failing user_path_dishes read (500) makes getPathSlot fail', async () => {
      mockFetch.mockResolvedValueOnce(ok([slotRow])).mockResolvedValueOnce(fail(500, '{}'));
      await expect(repo.getPathSlot(10, USER_ID)).rejects.toThrow(/500/);
    });

    it('getCanonicalPathSlot never reads user_path_dishes', async () => {
      mockFetch.mockResolvedValueOnce(ok([slotRow]));
      expect((await repo.getCanonicalPathSlot(10))?.dishName).toBe('Roast Chicken');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws a 400 with a code other than 42703 from the dietary select', async () => {
      mockFetch.mockResolvedValueOnce(fail(400, JSON.stringify({ code: 'PGRST100' })));
      await expect(repo.getUserProfile(USER_ID)).rejects.toThrow(/400/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still throws other failures from the dietary select', async () => {
      mockFetch.mockResolvedValueOnce(fail(500, '{}'));
      await expect(repo.getUserProfile(USER_ID)).rejects.toThrow(/500/);
    });
  });

  describe('normalizeEquipment', () => {
    it('trims, drops empties, dedupes case-insensitively and caps count and length', () => {
      expect(normalizeEquipment(null)).toEqual([]);
      expect(normalizeEquipment([' Wok ', 'wok', '', 'WOK', 'knife'])).toEqual(['Wok', 'knife']);
      expect(normalizeEquipment(['y'.repeat(101)])).toEqual(['y'.repeat(100)]);
      expect(normalizeEquipment(Array.from({ length: 51 }, (_, i) => `t${i}`))).toHaveLength(50);
    });
  });

  describe('isSlotUnlocked', () => {
    it('calls the is_slot_unlocked RPC', async () => {
      mockFetch.mockResolvedValueOnce(ok(true));
      expect(await repo.isSlotUnlocked(USER_ID, 3)).toBe(true);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/is_slot_unlocked');
      expect(JSON.parse(init.body as string)).toEqual({ p_user_id: USER_ID, p_slot_id: 3 });
    });

    it('anything but true is locked', async () => {
      mockFetch.mockResolvedValueOnce(ok(false));
      expect(await repo.isSlotUnlocked(USER_ID, 3)).toBe(false);
      mockFetch.mockResolvedValueOnce(ok(null));
      expect(await repo.isSlotUnlocked(USER_ID, 3)).toBe(false);
    });

    it('throws on errors without leaking the key', async () => {
      mockFetch.mockResolvedValueOnce(fail(500, '{"message":"boom"}'));
      const error = await repo.isSlotUnlocked(USER_ID, 3).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('500');
      expect((error as Error).message).not.toContain(KEY);
    });
  });

  describe('badgesEarnedBy', () => {
    it('returns the badges from get_badges_earned_by_check_in', async () => {
      const badges = [
        { code: 'mastery', name: 'Roast Chicken Mastery', description: 'd', kind: 'mastery' },
        { code: 'path_weeknight_basics', name: 'Graduate', description: 'd', kind: 'path_milestone' },
      ];
      mockFetch.mockResolvedValueOnce(ok(badges));
      expect(await repo.badgesEarnedBy('c1')).toEqual(badges);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/get_badges_earned_by_check_in');
      expect(JSON.parse(init.body as string)).toEqual({ p_check_in_id: 'c1' });
    });

    it('rejects an unexpected shape', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ code: 'x' }]));
      await expect(repo.badgesEarnedBy('c1')).rejects.toThrow();
    });
  });

  it('times out a hung request', async () => {
    repo = new SupabasePathRepository({ url: 'https://test-project.supabase.co', serviceRoleKey: KEY, timeoutMs: 20 });
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(repo.getPathSlot(1, USER_ID)).rejects.toThrow(/timed out after 20ms/);
  });
});
