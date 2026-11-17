import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeReconcileCandidates, SupabaseReconcileSource } from './supabase-reconcile-source.js';

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

  function ok(rows: unknown[]): { ok: true; json: () => Promise<unknown[]> } {
    return { ok: true, json: () => Promise.resolve(rows) };
  }

  it('queries both check-in tables for rows with no XP event, oldest first, bounded', async () => {
    mockFetch.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/check_ins')) {
        return ok([
          { id: 'slot-new', slot_id: 2, created_at: '2026-11-11T12:00:00.000Z', xp_events: null },
          { id: 'slot-old', slot_id: 1, created_at: '2026-11-10T12:00:00.000Z', xp_events: null },
        ]);
      }
      return ok([
        { id: 'gen-mid', created_at: '2026-11-10T18:00:00.000Z', generated_recipe_xp_events: null },
      ]);
    });

    const rows = await source.findCheckInsMissingXp({ ...WINDOW, limit: 2 });

    const calls = mockFetch.mock.calls.map(([rawUrl, options]) => ({
      url: new URL(rawUrl as string),
      options: options as RequestInit,
    }));
    const slot = calls.find((call) => call.url.pathname.endsWith('/check_ins'));
    const generated = calls.find((call) => call.url.pathname.endsWith('/generated_recipe_check_ins'));
    expect(slot).toBeDefined();
    expect(generated).toBeDefined();
    expect(slot!.url.origin + slot!.url.pathname).toBe(
      'https://test-project.supabase.co/rest/v1/check_ins'
    );
    expect(slot!.url.searchParams.get('select')).toBe('id,slot_id,created_at,xp_events(id)');
    expect(slot!.url.searchParams.get('xp_events')).toBe('is.null');
    expect(generated!.url.searchParams.get('select')).toBe(
      'id,created_at,generated_recipe_xp_events(id)'
    );
    expect(generated!.url.searchParams.get('generated_recipe_xp_events')).toBe('is.null');
    for (const call of [slot!, generated!]) {
      expect(call.url.searchParams.getAll('created_at')).toEqual([
        'gte.2026-11-05T22:00:00.000Z',
        'lte.2026-11-12T21:58:00.000Z',
      ]);
      expect(call.url.searchParams.get('order')).toBe('created_at.asc,id.asc');
      expect(call.url.searchParams.get('limit')).toBe('2');
      expect(call.options.method).toBe('GET');
      expect(call.options.signal).toBeInstanceOf(AbortSignal);
      expect(call.options.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    }
    expect(rows).toEqual([
      { check_in_id: 'slot-old', slot_id: 1, created_at: '2026-11-10T12:00:00.000Z', kind: 'slot' },
      { check_in_id: 'gen-mid', slot_id: null, created_at: '2026-11-10T18:00:00.000Z', kind: 'generated' },
    ]);
  });

  it('never selects check-in text or user ids', () => {
    for (const select of [
      new URL(source.buildUrl(WINDOW)).searchParams.get('select') ?? '',
      new URL(source.buildGeneratedUrl(WINDOW)).searchParams.get('select') ?? '',
    ]) {
      expect(select).not.toMatch(/went_well|was_hard|user_id|dish|\*/);
    }
  });

  it('throws on a non-OK response without leaking the key', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('oops') });
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
});

describe('mergeReconcileCandidates', () => {
  it('orders by created_at then id and applies the shared limit', () => {
    const merged = mergeReconcileCandidates(
      [
        { check_in_id: 'b', slot_id: 2, created_at: '2026-11-11T00:00:00.000Z', kind: 'slot' },
        { check_in_id: 'a', slot_id: null, created_at: '2026-11-10T00:00:00.000Z', kind: 'generated' },
        { check_in_id: 'c', slot_id: null, created_at: '2026-11-11T00:00:00.000Z', kind: 'generated' },
      ],
      2
    );
    expect(merged.map((row) => row.check_in_id)).toEqual(['a', 'b']);
  });
});
