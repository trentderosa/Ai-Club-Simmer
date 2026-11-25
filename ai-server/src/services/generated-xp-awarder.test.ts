import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SupabaseGeneratedXpAwarder } from './generated-xp-awarder.js';
import { DEFAULT_XP_AWARD_TIMEOUT_MS, XpAwardError, xpAwardErrorReason } from './xp-awarder.js';

const mockFetch = vi.fn();
const KEY = 'test-service-role-key';
const URL_BASE = 'https://test-project.supabase.co';

function uniqueViolationBody(): string {
  return JSON.stringify({
    code: '23505',
    message: 'duplicate key value violates unique constraint "generated_recipe_xp_events_check_in_id_key"',
  });
}

function uniqueViolationResponse(): { ok: false; status: number; text: () => Promise<string> } {
  return { ok: false, status: 409, text: (): Promise<string> => Promise.resolve(uniqueViolationBody()) };
}

const RECIPE_ID = randomUUID();

function recipeXpResponse(xpValue: number): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: () => Promise.resolve([{ xp_value: xpValue }]) };
}

describe('SupabaseGeneratedXpAwarder', () => {
  let awarder: SupabaseGeneratedXpAwarder;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    awarder = new SupabaseGeneratedXpAwarder({ url: URL_BASE, serviceRoleKey: KEY });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs award_generated_recipe_xp RPC with the check_in_id and service-role headers', async () => {
    const checkInId = randomUUID();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { out_xp_awarded: 40, out_is_first_completion: true, out_weekly_repeat_remaining: 3, out_capped: false },
        ]),
    });

    const result = await awarder.award(checkInId);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}/rest/v1/rpc/award_generated_recipe_xp`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ p_check_in_id: checkInId });
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(result).toEqual({
      xp_awarded: 40,
      is_first_completion: true,
      weekly_repeat_remaining: 3,
      capped: false,
    });
  });

  it('accepts a single-object RPC response and a capped repeat with 0 XP', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          out_xp_awarded: 0,
          out_is_first_completion: false,
          out_weekly_repeat_remaining: 0,
          out_capped: true,
        }),
    });
    await expect(awarder.award(randomUUID())).resolves.toEqual({
      xp_awarded: 0,
      is_first_completion: false,
      weekly_repeat_remaining: 0,
      capped: true,
    });
  });

  it('throws reason "http" on a non-OK response without leaking the key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"code":"42501","message":"permission denied for function award_generated_recipe_xp"}'),
    });

    const err = await awarder.award(randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XpAwardError);
    expect(xpAwardErrorReason(err)).toBe('http');
    expect((err as XpAwardError).status).toBe(403);
    expect((err as Error).message).toContain('award_generated_recipe_xp failed: 403');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('treats non-23505 409s and 23505 on non-409 statuses as reason "http"', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409, text: () => Promise.resolve('not json') });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'http', status: 409 });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: () => Promise.resolve('{"code":"40001","message":"serialization failure"}'),
    });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'http', status: 409 });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve(uniqueViolationBody()) });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'http', status: 400 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws invalid_response when the RPC returns no usable row', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await expect(awarder.award(randomUUID())).rejects.toThrow('no result row');

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'invalid_response' });

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ out_xp_awarded: '40' }]) });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'invalid_response' });

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(null) });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('maps a malformed JSON body (json() rejects) to reason "network"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });
    await expect(awarder.award(randomUUID())).rejects.toMatchObject({
      reason: 'network',
      // The SyntaxError message can quote the body, so it is replaced by a fixed string.
      message: 'award_generated_recipe_xp request failed: invalid JSON response',
    });
  });

  it('passes an AbortSignal and rejects with reason "timeout" when the RPC hangs', async () => {
    const slow = new SupabaseGeneratedXpAwarder({ url: URL_BASE, serviceRoleKey: KEY, timeoutMs: 20 });
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
    expect((err as Error).message).toBe('award_generated_recipe_xp timed out after 20ms');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('times out while reading a slow response body too', async () => {
    const slow = new SupabaseGeneratedXpAwarder({ url: URL_BASE, serviceRoleKey: KEY, timeoutMs: 20 });
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
            { out_xp_awarded: 40, out_is_first_completion: true, out_weekly_repeat_remaining: 3, out_capped: false },
          ]),
      });
      await awarder.award(randomUUID());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts exactly at the default 5000ms with fake timers', async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            seenSignal = options.signal ?? undefined;
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const pending = awarder.award(randomUUID()).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(4999);
      expect(seenSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(seenSignal?.aborted).toBe(true);
      const err = await pending;
      expect(xpAwardErrorReason(err)).toBe('timeout');
      expect((err as Error).message).toBe('award_generated_recipe_xp timed out after 5000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the existing generated_recipe_xp_events row when the RPC hits UNIQUE(check_in_id)', async () => {
    const checkInId = randomUUID();
    mockFetch.mockResolvedValueOnce(uniqueViolationResponse()).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ xp_awarded: 40, is_first_completion: true, generated_recipe_id: RECIPE_ID }]),
    }).mockResolvedValueOnce(recipeXpResponse(40));

    const result = await awarder.award(checkInId);

    expect(result).toEqual({
      xp_awarded: 40,
      is_first_completion: true,
      weekly_repeat_remaining: 0,
      capped: false,
    });
    const [url, options] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/rest/v1/generated_recipe_xp_events');
    expect(url).toContain(`check_in_id=eq.${checkInId}`);
    expect(url).toContain('limit=1');
    expect(options.method).toBe('GET');
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
  });

  it('marks a read-back repeat with 0 XP as capped, and a repeat with XP as not capped', async () => {
    mockFetch.mockResolvedValueOnce(uniqueViolationResponse()).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ xp_awarded: 0, is_first_completion: false }]),
    });
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 0, capped: true });

    mockFetch
      .mockResolvedValueOnce(uniqueViolationResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ xp_awarded: 20, is_first_completion: false, generated_recipe_id: RECIPE_ID }]),
      })
      .mockResolvedValueOnce(recipeXpResponse(40));
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 20, capped: false });
  });

  function readBack(row: Record<string, unknown>): void {
    mockFetch
      .mockResolvedValueOnce(uniqueViolationResponse())
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ generated_recipe_id: RECIPE_ID, ...row }]) });
  }

  it('reads back a partially capped repeat as capped, using the recipe xp_value', async () => {
    readBack({ xp_awarded: 5, is_first_completion: false });
    mockFetch.mockResolvedValueOnce(recipeXpResponse(40));
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 5, capped: true });
    const [url, options] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('/rest/v1/user_generated_recipes');
    expect(url).toContain(`id=eq.${RECIPE_ID}`);
    expect(options.method).toBe('GET');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads back a daily-capped first completion as capped, and an uncapped one as not capped', async () => {
    readBack({ xp_awarded: 30, is_first_completion: true });
    mockFetch.mockResolvedValueOnce(recipeXpResponse(40));
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 30, capped: true });

    readBack({ xp_awarded: 40, is_first_completion: true });
    mockFetch.mockResolvedValueOnce(recipeXpResponse(40));
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 40, capped: false });
  });

  it('falls back to the 0-XP-repeat heuristic when the recipe lookup fails', async () => {
    readBack({ xp_awarded: 5, is_first_completion: false });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 5, capped: false });

    readBack({ xp_awarded: 0, is_first_completion: false });
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 0, capped: true });

    readBack({ xp_awarded: 30, is_first_completion: true });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    await expect(awarder.award(randomUUID())).resolves.toMatchObject({ xp_awarded: 30, capped: false });
  });

  it('rejects with reason "timeout" when the abort fires during the recipe lookup', async () => {
    const slow = new SupabaseGeneratedXpAwarder({ url: URL_BASE, serviceRoleKey: KEY, timeoutMs: 20 });
    readBack({ xp_awarded: 5, is_first_completion: false });
    mockFetch.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const err = await slow.award(randomUUID()).catch((e: unknown) => e);
    expect(xpAwardErrorReason(err)).toBe('timeout');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('throws already_awarded (status 409) when the duplicate row cannot be read back', async () => {
    // Empty result, failed read, and malformed row each fall through to already_awarded.
    mockFetch.mockResolvedValueOnce(uniqueViolationResponse()).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });
    mockFetch.mockResolvedValueOnce(uniqueViolationResponse()).mockResolvedValueOnce({ ok: false, status: 500 });
    mockFetch.mockResolvedValueOnce(uniqueViolationResponse()).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ xp_awarded: '40', is_first_completion: true }]),
    });

    for (let i = 0; i < 3; i++) {
      const err = await awarder.award(randomUUID()).catch((e: unknown) => e);
      expect(xpAwardErrorReason(err)).toBe('already_awarded');
      expect((err as XpAwardError).status).toBe(409);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('maps a fetch rejection that is not a timeout to reason "network" without leaking the key', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const err = await awarder.award(randomUUID()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      reason: 'network',
      message: 'award_generated_recipe_xp request failed: fetch failed',
    });
    expect((err as Error).message).not.toContain(KEY);
  });

  it('never writes keys to the console on failure paths', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    try {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('boom') });
      await awarder.award(randomUUID()).catch(() => undefined);
      mockFetch.mockRejectedValueOnce(new Error('down'));
      await awarder.award(randomUUID()).catch(() => undefined);
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
