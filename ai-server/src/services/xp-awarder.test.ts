import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SupabaseXpAwarder } from './xp-awarder.js';

const mockFetch = vi.fn();
const KEY = 'test-service-role-key';

describe('SupabaseXpAwarder', () => {
  let awarder: SupabaseXpAwarder;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    awarder = new SupabaseXpAwarder({ url: 'https://test-project.supabase.co', serviceRoleKey: KEY });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs award_slot_xp RPC with the check_in_id and service-role headers', async () => {
    const checkInId = randomUUID();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { out_xp_awarded: 102, out_is_first_completion: true, out_weekly_repeat_remaining: 100, out_capped: false },
        ]),
    });

    const result = await awarder.award(checkInId);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/award_slot_xp');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ p_check_in_id: checkInId });
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(result).toEqual({
      xp_awarded: 102,
      is_first_completion: true,
      weekly_repeat_remaining: 100,
      capped: false,
    });
  });

  it('throws on a non-OK response without leaking the key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"code":"42501","message":"permission denied for function award_slot_xp"}'),
    });

    const err = await awarder.award(randomUUID()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('award_slot_xp failed: 403');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('throws when the RPC returns no row', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await expect(awarder.award(randomUUID())).rejects.toThrow('no result row');
  });
});
