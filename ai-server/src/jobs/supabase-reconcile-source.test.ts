import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseReconcileSource } from './supabase-reconcile-source.js';

const mockFetch = vi.fn();
const KEY = 'test-service-role-key';
const WINDOW = {
  from: new Date('2026-11-05T22:00:00.000Z'),
  to: new Date('2026-11-12T21:58:00.000Z'),
  limit: 50,
  maxAttempts: 5,
  retryBaseMinutes: 10,
};

describe('SupabaseReconcileSource', () => {
  let source: SupabaseReconcileSource;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    source = new SupabaseReconcileSource({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown): { ok: true; status: number; text: () => Promise<string> } {
    return {
      ok: true,
      status: body === undefined ? 204 : 200,
      text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
    };
  }

  it('calls get_xp_reconcile_candidates with the window, limit and max attempts', async () => {
    mockFetch.mockResolvedValue(
      ok([
        { check_in_id: 'slot-old', slot_id: 1, created_at: '2026-11-10T12:00:00.000Z', kind: 'slot' },
        { check_in_id: 'gen-mid', slot_id: null, created_at: '2026-11-10T18:00:00.000Z', kind: 'generated' },
      ])
    );

    const rows = await source.findCheckInsMissingXp(WINDOW);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [rawUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(rawUrl).toBe('https://test-project.supabase.co/rest/v1/rpc/get_xp_reconcile_candidates');
    expect(options.method).toBe('POST');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(options.body as string)).toEqual({
      p_from: '2026-11-05T22:00:00.000Z',
      p_to: '2026-11-12T21:58:00.000Z',
      p_limit: 50,
      p_max_attempts: 5,
      p_retry_base_minutes: 10,
    });
    expect(rows).toEqual([
      { check_in_id: 'slot-old', slot_id: 1, created_at: '2026-11-10T12:00:00.000Z', kind: 'slot' },
      { check_in_id: 'gen-mid', slot_id: null, created_at: '2026-11-10T18:00:00.000Z', kind: 'generated' },
    ]);
  });

  it('counts given-up check-ins', async () => {
    mockFetch.mockResolvedValue(ok(7));
    await expect(source.countGivenUp(WINDOW)).resolves.toBe(7);
    const [rawUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(rawUrl).toBe('https://test-project.supabase.co/rest/v1/rpc/count_xp_reconcile_given_up');
    expect(JSON.parse(options.body as string)).toEqual({
      p_from: '2026-11-05T22:00:00.000Z',
      p_to: '2026-11-12T21:58:00.000Z',
      p_max_attempts: 5,
    });
  });

  it('records a failed attempt with the kind and a reason code only', async () => {
    mockFetch.mockResolvedValue(ok(undefined));
    await source.recordFailedAttempt(
      { check_in_id: 'c1', slot_id: 1, created_at: '2026-11-10T12:00:00.000Z', kind: 'slot' },
      'timeout'
    );
    await source.recordFailedAttempt(
      { check_in_id: 'c2', slot_id: null, created_at: '2026-11-10T12:00:00.000Z', kind: 'generated' },
      'http'
    );
    const bodies = mockFetch.mock.calls.map(([, o]) => JSON.parse((o as RequestInit).body as string) as unknown);
    expect(mockFetch.mock.calls[0][0]).toBe('https://test-project.supabase.co/rest/v1/rpc/record_xp_award_attempt');
    expect(bodies).toEqual([
      { p_check_in_id: 'c1', p_kind: 'path', p_reason: 'timeout' },
      { p_check_in_id: 'c2', p_kind: 'generated', p_reason: 'http' },
    ]);
  });

  it('throws on a non-OK response without leaking the key', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('oops') });
    const err = await source.findCheckInsMissingXp(WINDOW).catch((e: Error) => e);
    expect((err as Error).message).toBe('Database error listing check-ins missing XP: 500 oops');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('rejects an unexpected (non-array) candidate response', async () => {
    mockFetch.mockResolvedValue(ok({ nope: true }));
    await expect(source.findCheckInsMissingXp(WINDOW)).rejects.toThrow('unexpected response');
  });

  it('times out a hung scan', async () => {
    const slow = new SupabaseReconcileSource({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 20,
    });
    mockFetch.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(slow.findCheckInsMissingXp(WINDOW)).rejects.toThrow(
      'Listing check-ins missing XP timed out after 20ms'
    );
  });

  it('lists given-up ids with a limit', async () => {
    mockFetch.mockResolvedValue(ok([{ check_in_id: 'a' }, { check_in_id: 'b' }]));
    await expect(source.listGivenUp(WINDOW, 20)).resolves.toEqual(['a', 'b']);
    const [rawUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(rawUrl).toBe('https://test-project.supabase.co/rest/v1/rpc/list_xp_reconcile_given_up');
    expect(JSON.parse(options.body as string)).toMatchObject({ p_max_attempts: 5, p_limit: 20 });
  });

  it('says the migration is not applied on a 404 / PGRST202, without leaking the key', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"code":"PGRST202","message":"Could not find the function"}'),
    });
    const err = (await source.findCheckInsMissingXp(WINDOW).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('xp_award_attempts migration not applied (20261118120000)');
    expect(err.message).not.toContain(KEY);
  });
});
