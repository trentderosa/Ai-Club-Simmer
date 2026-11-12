import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  DEFAULT_XP_AWARD_TIMEOUT_MS,
  SupabaseXpAwarder,
  XpAwardError,
  xpAwardErrorReason,
} from './xp-awarder.js';

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
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('passes an AbortSignal and rejects with reason "timeout" when the RPC hangs', async () => {
    const slow = new SupabaseXpAwarder({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 20,
    });
    let seenSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) => {
      seenSignal = options.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const abortError = new Error('This operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    });

    const err = await slow.award(randomUUID()).catch((e: unknown) => e);

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(XpAwardError);
    expect(xpAwardErrorReason(err)).toBe('timeout');
    expect((err as Error).message).toBe('award_slot_xp timed out after 20ms');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('times out while reading a slow response body too', async () => {
    const slow = new SupabaseXpAwarder({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 20,
    });
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      })
    );

    await expect(slow.award(randomUUID())).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('defaults the timeout to 5000ms and clears the timer after a fast response', async () => {
    expect(DEFAULT_XP_AWARD_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { out_xp_awarded: 62, out_is_first_completion: true, out_weekly_repeat_remaining: 100, out_capped: false },
          ]),
      });
      await awarder.award(randomUUID());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a 409 unique violation (xp_events.check_in_id) to reason "already_awarded"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: () =>
        Promise.resolve(
          '{"code":"23505","message":"duplicate key value violates unique constraint \\"xp_events_check_in_id_key\\""}'
        ),
    });

    const err = await awarder.award(randomUUID()).catch((e: unknown) => e);
    expect(xpAwardErrorReason(err)).toBe('already_awarded');
    expect((err as XpAwardError).status).toBe(409);
  });

  it('treats other non-OK responses (including non-23505 409s) as reason "http"', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409, text: () => Promise.resolve('not json') });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'http', status: 409 });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"code":"P0001","message":"Invalid or non-existent check_in_id"}'),
    });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'http', status: 400 });
  });

  it('maps a fetch rejection that is not a timeout to reason "network"', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({
      reason: 'network',
      message: 'award_slot_xp request failed: fetch failed',
    });
  });
});
