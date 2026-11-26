import { createLiveBackend } from './live-backend';

const mockUpsert = jest.fn();
const mockRpc = jest.fn();
const authHandlers: ((event: string, session: unknown) => void)[] = [];
const mockSelect = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `simmer://${path}`,
  getInitialURL: async () => null,
  addEventListener: () => ({ remove: () => undefined }),
}));

jest.mock('./supabase', () => ({
  createSupabaseClient: () => ({
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authHandlers.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      getSession: async () => ({ data: { session: null }, error: null }),
      startAutoRefresh: () => undefined,
      stopAutoRefresh: () => undefined,
    },
    from: () => ({
      upsert: (row: unknown) => mockUpsert(row),
      select: (cols: string) => {
        return { eq: () => ({ maybeSingle: async () => mockSelect(cols) }) };
      },
    }),
    rpc: (fn: string) => mockRpc(fn),
  }),
}));

function backend() {
  return createLiveBackend({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-test-key', ai: 'https://ai.example.invalid' });
}

const oldRow = { id: 'u1', goals: null, experience_level: null, equipment: null, budget: null, days_per_week: null, minutes_per_session: null, onboarding_completed: false };
const missingSelect = { data: null, error: { message: 'column profiles.cuisines does not exist', code: '42703' } };
const missingUpsert = { error: { message: "Could not find the 'cuisines' column of 'profiles' in the schema cache", code: 'PGRST204' } };

const input = {
  goals: '',
  experience_level: 'a_little' as const,
  equipment: ['stove'],
  budget: 'low' as const,
  days_per_week: 3,
  minutes_per_session: 30,
  cuisines: ['mexican' as const],
  meal_types: ['meal_prep' as const],
  dietary_needs: ['vegan' as const, 'vegetarian' as const],
};

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://app.example.invalid/' }, history: { state: null, replaceState() {} } },
  });
});

beforeEach(() => {
  mockUpsert.mockReset().mockResolvedValue({ error: null });
  mockRpc.mockReset();
  authHandlers.length = 0;
  jest.restoreAllMocks();
  mockSelect.mockReset().mockResolvedValue({ data: oldRow, error: null });
});

describe('live backend personalization', () => {
  it('sends cuisines, meal_types and dietary_needs on the profile upsert', async () => {
    await backend().saveOnboarding('u1', input);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', cuisines: ['mexican'], meal_types: ['meal_prep'], dietary_needs: ['vegan', 'vegetarian'], onboarding_completed: true }));
  });

  it('sends empty lists when the caller omits the taste fields', async () => {
    const { cuisines: _c, meal_types: _m, dietary_needs: _d, ...older } = input;
    await backend().saveOnboarding('u1', older);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ cuisines: [], meal_types: [], dietary_needs: [] }));
  });

  it('reads the taste columns and tolerates a row without them', async () => {
    const profile = await backend().getProfile('u1');
    expect(mockSelect.mock.calls[0][0]).toContain('cuisines');
    expect(profile).toMatchObject({ cuisines: [], meal_types: [], dietary_needs: [] });
  });

  it('calls the personalize_my_path RPC and validates the rows', async () => {
    mockRpc.mockResolvedValue({ data: [{ slot_id: 1, dish_name: 'Pico de Gallo' }], error: null });
    await expect(backend().personalizeMyPath()).resolves.toEqual([{ slot_id: 1, dish_name: 'Pico de Gallo' }]);
    expect(mockRpc).toHaveBeenCalledWith('personalize_my_path');
  });

  it('rejects a malformed RPC result', async () => {
    mockRpc.mockResolvedValue({ data: [{ slot_id: 'one' }], error: null });
    await expect(backend().personalizeMyPath()).rejects.toBeDefined();
  });

  it('surfaces a missing function as an error for the caller to swallow', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function public.personalize_my_path', code: 'PGRST202', status: 404 } });
    await expect(backend().personalizeMyPath()).rejects.toBeDefined();
  });

  describe('rollout tolerance (database without the taste columns)', () => {
    it('getProfile retries with the old columns, defaults to [], and remembers', async () => {
      mockSelect.mockResolvedValueOnce(missingSelect).mockResolvedValue({ data: oldRow, error: null });
      const b = backend();
      expect(await b.getProfile('u1')).toMatchObject({ cuisines: [], meal_types: [], dietary_needs: [] });
      expect(mockSelect).toHaveBeenCalledTimes(2);
      expect(mockSelect.mock.calls[1][0]).not.toContain('cuisines');
      await b.getProfile('u1');
      expect(mockSelect).toHaveBeenCalledTimes(3); // no second failing call
      expect(mockSelect.mock.calls[2][0]).not.toContain('cuisines');
    });

    it('getProfile does not swallow a different error', async () => {
      mockSelect.mockResolvedValue({ data: null, error: { message: 'permission denied for table profiles', code: '42501' } });
      await expect(backend().getProfile('u1')).rejects.toBeDefined();
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('the upsert retries once without the taste fields, quietly, and remembers', async () => {
      mockUpsert.mockResolvedValueOnce(missingUpsert).mockResolvedValue({ error: null });
      const b = backend();
      await expect(b.saveOnboarding('u1', input)).resolves.toEqual({ tasteSaved: false });
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      const retry = mockUpsert.mock.calls[1][0] as Record<string, unknown>;
      expect(retry).not.toHaveProperty('cuisines');
      expect(retry).not.toHaveProperty('dietary_needs');
      expect(retry).toMatchObject({ id: 'u1', onboarding_completed: true });
      await b.saveOnboarding('u1', input);
      expect(mockUpsert).toHaveBeenCalledTimes(3); // straight to the old shape
      expect(mockUpsert.mock.calls[2][0]).not.toHaveProperty('meal_types');
    });

    it('the upsert does not swallow a different error', async () => {
      mockUpsert.mockResolvedValue({ error: { message: 'new row violates row-level security policy', code: '42501' } });
      await expect(backend().saveOnboarding('u1', input)).rejects.toBeDefined();
      expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it('still surfaces an error from the retried upsert', async () => {
      mockUpsert.mockResolvedValueOnce(missingUpsert).mockResolvedValue({ error: { message: 'boom', code: 'XX000' } });
      await expect(backend().saveOnboarding('u1', input)).rejects.toBeDefined();
    });

    it('reports tasteSaved: false when taste answers could not be stored, true otherwise', async () => {
      mockUpsert.mockResolvedValueOnce(missingUpsert).mockResolvedValue({ error: null });
      const b = backend();
      await expect(b.saveOnboarding('u1', input)).resolves.toEqual({ tasteSaved: false });
      await expect(b.saveOnboarding('u1', input)).resolves.toEqual({ tasteSaved: false }); // remembered path
      const { cuisines: _c, meal_types: _m, dietary_needs: _d, ...older } = input;
      await expect(b.saveOnboarding('u1', older)).resolves.toEqual({ tasteSaved: true }); // nothing to lose
    });

    it('reports tasteSaved: true on a normal database', async () => {
      await expect(backend().saveOnboarding('u1', input)).resolves.toEqual({ tasteSaved: true });
    });

    it('does not remember the flag when the getProfile retry also fails', async () => {
      mockSelect.mockResolvedValueOnce(missingSelect).mockResolvedValueOnce({ data: null, error: { message: 'down', code: 'XX000' } }).mockResolvedValue({ data: oldRow, error: null });
      const b = backend();
      await expect(b.getProfile('u1')).rejects.toBeDefined();
      await b.getProfile('u1');
      expect(mockSelect.mock.calls[2][0]).toContain('cuisines'); // tried the full list again
    });

    it('re-checks after 10 minutes', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      mockSelect.mockResolvedValueOnce(missingSelect).mockResolvedValue({ data: oldRow, error: null });
      const b = backend();
      await b.getProfile('u1'); // fails, retries, remembers
      now += 9 * 60 * 1000;
      await b.getProfile('u1');
      expect(mockSelect.mock.calls[2][0]).not.toContain('cuisines');
      now += 2 * 60 * 1000;
      await b.getProfile('u1');
      expect(mockSelect.mock.calls[3][0]).toContain('cuisines');
    });

    it('forgets the flag on sign-in', async () => {
      mockSelect.mockResolvedValueOnce(missingSelect).mockResolvedValue({ data: oldRow, error: null });
      const b = backend();
      await b.getProfile('u1');
      authHandlers.forEach((h) => h('SIGNED_IN', null));
      await b.getProfile('u1');
      expect(mockSelect.mock.calls[2][0]).toContain('cuisines');
    });
  });

  describe('stale taste preload', () => {
    it('does not send taste keys (or includeTaste) when includeTaste is false', async () => {
      await expect(backend().saveOnboarding('u1', { ...input, dietary_needs: [], includeTaste: false })).resolves.toEqual({ tasteSaved: true });
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const row = mockUpsert.mock.calls[0][0] as Record<string, unknown>;
      for (const k of ['cuisines', 'meal_types', 'dietary_needs', 'includeTaste']) expect(row).not.toHaveProperty(k);
    });

    it('sends them when includeTaste is true, and never leaks includeTaste', async () => {
      await backend().saveOnboarding('u1', { ...input, includeTaste: true });
      const row = mockUpsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row).toHaveProperty('dietary_needs', ['vegan', 'vegetarian']);
      expect(row).not.toHaveProperty('includeTaste');
    });

    it('marks a profile read without the taste columns as tasteLoaded: false', async () => {
      mockSelect.mockResolvedValueOnce(missingSelect).mockResolvedValue({ data: oldRow, error: null });
      const b = backend();
      expect((await b.getProfile('u1'))?.tasteLoaded).toBe(false);
      expect((await b.getProfile('u1'))?.tasteLoaded).toBe(false); // remembered path
    });

    it('marks a normal read as tasteLoaded: true', async () => {
      mockSelect.mockResolvedValue({ data: { ...oldRow, cuisines: ['thai'], meal_types: [], dietary_needs: [] }, error: null });
      expect((await backend().getProfile('u1'))?.tasteLoaded).toBe(true);
    });
  });
});
