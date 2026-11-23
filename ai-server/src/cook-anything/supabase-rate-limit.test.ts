import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseGenerationRateLimiter } from './supabase-rate-limit.js';

const mockFetch = vi.fn();
const KEY = 'test-service-role-key';
const USER = '550e8400-e29b-41d4-a716-446655440000';

function ok(body: string): { ok: true; text: () => Promise<string> } {
  return { ok: true, text: () => Promise.resolve(body) };
}

describe('SupabaseGenerationRateLimiter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the database to consume one hit and does not send a clock by default', async () => {
    mockFetch.mockResolvedValueOnce(ok('true'));
    const limiter = new SupabaseGenerationRateLimiter({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 3_600_000,
      maxGenerations: 5,
    });

    await expect(limiter.allow(USER)).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/try_cook_anything_generation');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      p_user_id: USER,
      p_window_ms: 3_600_000,
      p_max: 5,
    });
    expect(options.headers).toMatchObject({
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    });
  });

  it('returns false when the database says the window is full', async () => {
    mockFetch.mockResolvedValueOnce(ok('false'));
    const limiter = new SupabaseGenerationRateLimiter({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 60_000,
      maxGenerations: 1,
    });
    await expect(limiter.allow(USER)).resolves.toBe(false);
  });

  it('forwards an explicit clock when a test supplies one', async () => {
    mockFetch.mockResolvedValueOnce(ok('true'));
    const limiter = new SupabaseGenerationRateLimiter({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 1000,
      maxGenerations: 1,
    });
    const now = 1_700_000_000_000;
    await limiter.allow(USER, now);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string).p_now).toBe(new Date(now).toISOString());
  });

  it('throws on a non-boolean body and on HTTP errors without leaking the key', async () => {
    const limiter = new SupabaseGenerationRateLimiter({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 1000,
      maxGenerations: 1,
    });

    mockFetch.mockResolvedValueOnce(ok('1'));
    const nonBoolean = await limiter.allow(USER).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(nonBoolean).toContain('non-boolean');
    expect(nonBoolean).not.toContain(KEY);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"code":"42883","message":"function not found"}'),
    });
    const missing = await limiter.allow(USER).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(missing).toContain('failed: 404');
    expect(missing).not.toContain(KEY);
  });

  it('aborts a hung call and does not put the key in the timeout error', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    const limiter = new SupabaseGenerationRateLimiter({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 1000,
      maxGenerations: 1,
      timeoutMs: 20,
    });
    const timedOut = await limiter.allow(USER).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(timedOut).toContain('timed out after 20ms');
    expect(timedOut).not.toContain(KEY);
  });

  describe('refund', () => {
    const config = {
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      windowMs: 3_600_000,
      maxGenerations: 5,
    };

    it('calls refund_cook_anything_generation with the user and window and returns its boolean', async () => {
      mockFetch.mockResolvedValueOnce(ok('true')).mockResolvedValueOnce(ok('false'));
      const limiter = new SupabaseGenerationRateLimiter(config);

      await expect(limiter.refund(USER)).resolves.toBe(true);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/refund_cook_anything_generation');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body as string)).toEqual({ p_user_id: USER, p_window_ms: 3_600_000 });
      expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });

      await expect(limiter.refund(USER, 1_700_000_000_000)).resolves.toBe(false);
      const [, second] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(second.body as string).p_now).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('treats a missing function (PGRST202 / 404) as no refund and warns once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"code":"PGRST202","message":"Could not find the function"}'),
      });
      const limiter = new SupabaseGenerationRateLimiter(config);

      await expect(limiter.refund(USER)).resolves.toBe(false);
      await expect(limiter.refund(USER)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('cook_anything_refund_unavailable');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
      warn.mockRestore();
    });

    it('throws on other HTTP errors and on a non-boolean body without leaking the key', async () => {
      const limiter = new SupabaseGenerationRateLimiter(config);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      });
      const failed = await limiter.refund(USER).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      expect(failed).toContain('failed: 500');
      expect(failed).not.toContain(KEY);

      mockFetch.mockResolvedValueOnce(ok('1'));
      await expect(limiter.refund(USER)).rejects.toThrow(/non-boolean/);
    });
  });
});
