import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseReconcileSource } from './supabase-reconcile-source.js';

const mockFetch = vi.fn();
const KEY = 'test-service-role-key';
const WINDOW = {
  from: new Date('2026-11-05T22:00:00.000Z'),
  to: new Date('2026-11-12T21:58:00.000Z'),
  limit: 50,
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

  it('queries check_ins with no xp_events row inside the window, oldest first, bounded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 'c1', slot_id: 1, created_at: '2026-11-10T12:00:00+00:00', xp_events: null },
        ]),
    });

    const rows = await source.findCheckInsMissingXp(WINDOW);

    const [rawUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe('https://test-project.supabase.co/rest/v1/check_ins');
    expect(url.searchParams.get('select')).toBe('id,slot_id,created_at,xp_events(id)');
    expect(url.searchParams.get('xp_events')).toBe('is.null');
    expect(url.searchParams.getAll('created_at')).toEqual([
      'gte.2026-11-05T22:00:00.000Z',
      'lte.2026-11-12T21:58:00.000Z',
    ]);
    expect(url.searchParams.get('order')).toBe('created_at.asc,id.asc');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(options.method).toBe('GET');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(rows).toEqual([{ check_in_id: 'c1', slot_id: 1, created_at: '2026-11-10T12:00:00+00:00' }]);
  });

  it('never selects check-in text or user ids', () => {
    const select = new URL(source.buildUrl(WINDOW)).searchParams.get('select') ?? '';
    expect(select).not.toMatch(/went_well|was_hard|user_id|\*/);
  });

  it('throws on a non-OK response without leaking the key', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('oops') });
    const err = await source.findCheckInsMissingXp(WINDOW).catch((e: Error) => e);
    expect((err as Error).message).toBe('Database error listing check-ins missing XP: 500 oops');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('times out a hung scan', async () => {
    const slow = new SupabaseReconcileSource({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: KEY,
      timeoutMs: 20,
    });
    mockFetch.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(slow.findCheckInsMissingXp(WINDOW)).rejects.toThrow(
      'Listing check-ins missing XP timed out after 20ms'
    );
  });
});
