import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryYouTubeQuotaGate, SupabaseYouTubeQuotaGate, youtubeQuotaResetAt } from './youtube-quota.js';

const KEY = 'test-service-role-key';
const NOW = new Date('2026-02-01T00:00:00.000Z');
const UNTIL = youtubeQuotaResetAt(NOW);

function ok(body: string): { ok: true; text: () => Promise<string> } {
  return { ok: true, text: () => Promise.resolve(body) };
}

describe('SupabaseYouTubeQuotaGate', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records a search when the table has no pause', async () => {
    mockFetch.mockResolvedValueOnce(ok('null'));
    const gate = new SupabaseYouTubeQuotaGate({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
    });

    await expect(gate.claimSearches(2, NOW)).resolves.toBeNull();

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/claim_youtube_search');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      p_count: 2,
      p_now: NOW.toISOString(),
    });
    expect(options.headers).toMatchObject({
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    });
  });

  it('saves the pause and a later claim in this process does not ask again', async () => {
    mockFetch.mockResolvedValueOnce(ok(`"${UNTIL.toISOString()}"`));
    const gate = new SupabaseYouTubeQuotaGate({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
    });

    await expect(gate.recordCooldown(UNTIL, NOW)).resolves.toEqual(UNTIL);
    await expect(gate.claimSearches(1, NOW)).resolves.toEqual(UNTIL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-project.supabase.co/rest/v1/rpc/record_youtube_quota_cooldown');
    expect(JSON.parse(options.body as string)).toEqual({
      p_until: UNTIL.toISOString(),
      p_now: NOW.toISOString(),
    });
  });

  it('keeps the pause when the write fails and retries it without claiming another search', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"message":"unavailable"}'),
    });
    const gate = new SupabaseYouTubeQuotaGate({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
    });

    const failed = await gate.recordCooldown(UNTIL, NOW).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(failed).toContain('failed: 500');
    expect(failed).not.toContain(KEY);

    mockFetch.mockResolvedValueOnce(ok(`"${UNTIL.toISOString()}"`));
    await expect(gate.claimSearches(3, NOW)).resolves.toEqual(UNTIL);

    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://test-project.supabase.co/rest/v1/rpc/record_youtube_quota_cooldown',
      'https://test-project.supabase.co/rest/v1/rpc/record_youtube_quota_cooldown',
    ]);
  });

  it('rejects an unexpected body and a hung call without the key', async () => {
    const gate = new SupabaseYouTubeQuotaGate({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 20,
    });

    mockFetch.mockResolvedValueOnce(ok('1'));
    const bad = await gate.claimSearches(1, NOW).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(bad).toContain('unexpected value');
    expect(bad).not.toContain(KEY);

    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    const timedOut = await gate.claimSearches(1, NOW).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(timedOut).toContain('timed out after 20ms');
    expect(timedOut).not.toContain(KEY);
  });
});

describe('InMemoryYouTubeQuotaGate', () => {
  it('rejects a count outside 1 to 6 and records nothing', async () => {
    const gate = new InMemoryYouTubeQuotaGate();
    await expect(gate.claimSearches(0, NOW)).rejects.toThrow(/out of range/);
    await expect(gate.claimSearches(7, NOW)).rejects.toThrow(/out of range/);
    expect(gate.recordedSearches).toHaveLength(0);
  });
});
