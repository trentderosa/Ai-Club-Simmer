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

      const slot = await repo.getPathSlot(10);

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
      expect(await repo.getPathSlot(99)).toBeNull();
    });
  });

  describe('getNextPathSlot', () => {
    it('finds the next slot by slot_order, not by id', async () => {
      mockFetch
        .mockResolvedValueOnce(ok([{ slot_order: 4 }]))
        .mockResolvedValueOnce(
          ok([{ id: 41, dish_name: 'Pasta', technique_focus: 'Boiling', is_final: false }])
        );
      const slot = await repo.getNextPathSlot(37);
      expect(slot).toEqual({ id: 41, dishName: 'Pasta', techniqueFocus: 'Boiling', isFinal: false });
      expect(calledUrl(0).searchParams.get('id')).toBe('eq.37');
      expect(calledUrl(1).searchParams.get('slot_order')).toBe('eq.5');
    });

    it('returns null after the last slot or for an unknown slot', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ slot_order: 10 }])).mockResolvedValueOnce(ok([]));
      expect(await repo.getNextPathSlot(50)).toBeNull();
      mockFetch.mockResolvedValueOnce(ok([]));
      expect(await repo.getNextPathSlot(999)).toBeNull();
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
        );

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
        );
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
    await expect(repo.getPathSlot(1)).rejects.toThrow(/timed out after 20ms/);
  });
});
