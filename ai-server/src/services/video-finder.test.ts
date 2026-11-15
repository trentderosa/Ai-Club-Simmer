import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryTechniqueVideoCache,
  MAX_VIDEO_SEARCHES_PER_RECIPE,
  NEGATIVE_CACHE_TTL_MS,
  SupabaseTechniqueVideoCache,
  VideoFinder,
  YouTubeSearchClient,
  buildSearchQuery,
  normalizeTechniqueKey,
  type VideoSearchClient,
  type TechniqueVideo,
} from './video-finder.js';
import type { Recipe } from '../schemas/recipe.js';

const NOW = new Date('2026-11-15T12:00:00Z');

function recipeWith(techniques: (string | undefined)[]): Recipe {
  return {
    title: 'Test',
    ingredients: [{ name: 'egg', amount: '2' }],
    timeEstimateMinutes: 10,
    steps: techniques.map((t, i) => ({
      instruction: `Step ${i + 1}`,
      isSafetyStep: false,
      ...(t ? { techniqueName: t } : {}),
    })),
  };
}

function video(id: string): TechniqueVideo {
  return { videoId: id, title: `Video ${id}` };
}

function searchReturning(map: Record<string, TechniqueVideo | null>): VideoSearchClient & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn().mockImplementation((query: string) => {
      const key = Object.keys(map).find((k) => query === buildSearchQuery(k));
      return Promise.resolve(key ? map[key] : null);
    }),
  };
}

const logger = { warn: vi.fn() };

describe('normalizeTechniqueKey', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeTechniqueKey('  Dice   an Onion ')).toBe('dice an onion');
  });
});

describe('VideoFinder', () => {
  let cache: InMemoryTechniqueVideoCache;

  beforeEach(() => {
    cache = new InMemoryTechniqueVideoCache();
    logger.warn.mockReset();
  });

  it('searches once per distinct technique and keys results by the exact technique name', async () => {
    const search = searchReturning({ 'dice onion': video('abc123'), 'whisk eggs': video('def456') });
    const finder = new VideoFinder(cache, search, logger, () => NOW);

    const { videos, complete } = await finder.findForRecipe(
      recipeWith(['Dice onion', undefined, 'dice  onion', 'Whisk eggs'])
    );

    expect(complete).toBe(true);
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(search.search).toHaveBeenCalledWith('how to dice onion beginner cooking');
    expect(videos).toEqual({
      'Dice onion': video('abc123'),
      'dice  onion': video('abc123'),
      'Whisk eggs': video('def456'),
    });
  });

  it('uses the shared cache so another user never repeats a search', async () => {
    const search = searchReturning({ 'dice onion': video('abc123') });
    const finder = new VideoFinder(cache, search, logger, () => NOW);

    await finder.findForRecipe(recipeWith(['Dice onion']));
    const second = await finder.findForRecipe(recipeWith(['DICE ONION']));

    expect(search.search).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ videos: { 'DICE ONION': video('abc123') }, complete: true });
  });

  it('caches "no result" and retries it only after the TTL', async () => {
    const search = searchReturning({});
    let now = NOW;
    const finder = new VideoFinder(cache, search, logger, () => now);

    // A genuine "no result" is a complete answer (cached, safe to store).
    expect(await finder.findForRecipe(recipeWith(['obscure move']))).toEqual({ videos: {}, complete: true });
    expect(cache.entries.get('obscure move')?.video).toBeNull();

    now = new Date(NOW.getTime() + NEGATIVE_CACHE_TTL_MS - 1000);
    await finder.findForRecipe(recipeWith(['obscure move']));
    expect(search.search).toHaveBeenCalledTimes(1);

    now = new Date(NOW.getTime() + NEGATIVE_CACHE_TTL_MS + 1000);
    await finder.findForRecipe(recipeWith(['obscure move']));
    expect(search.search).toHaveBeenCalledTimes(2);
  });

  it('a failed search is skipped and not cached; the rest still work', async () => {
    const search: VideoSearchClient = {
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error('YouTube search failed: 403 quotaExceeded'))
        .mockResolvedValueOnce(video('def456')),
    };
    const finder = new VideoFinder(cache, search, logger, () => NOW);

    const { videos, complete } = await finder.findForRecipe(recipeWith(['Dice onion', 'Whisk eggs']));

    expect(videos).toEqual({ 'Whisk eggs': video('def456') });
    expect(complete).toBe(false);
    expect(cache.entries.has('dice onion')).toBe(false);
    expect(cache.entries.get('whisk eggs')?.video).toEqual(video('def456'));
    expect(logger.warn).toHaveBeenCalledWith('video_search_failed', {
      technique: 'dice onion',
      error: 'YouTube search failed: 403 quotaExceeded',
    });
  });

  it(`caps new searches at ${MAX_VIDEO_SEARCHES_PER_RECIPE} per recipe`, async () => {
    const search: VideoSearchClient = { search: vi.fn().mockResolvedValue(video('abc123')) };
    const finder = new VideoFinder(cache, search, logger, () => NOW);
    const names = Array.from({ length: MAX_VIDEO_SEARCHES_PER_RECIPE + 3 }, (_, i) => `technique ${i}`);

    const first = await finder.findForRecipe(recipeWith(names));

    expect(search.search).toHaveBeenCalledTimes(MAX_VIDEO_SEARCHES_PER_RECIPE);
    expect(Object.keys(first.videos)).toHaveLength(MAX_VIDEO_SEARCHES_PER_RECIPE);
    // Skipped techniques make the result incomplete, so it is looked up again...
    expect(first.complete).toBe(false);

    // ...and the next lookup searches only the ones that were skipped.
    const second = await finder.findForRecipe(recipeWith(names));
    expect(search.search).toHaveBeenCalledTimes(names.length);
    expect(Object.keys(second.videos)).toHaveLength(names.length);
    expect(second.complete).toBe(true);
  });

  it('runs the searches concurrently, not one after another', async () => {
    let active = 0;
    let maxActive = 0;
    const search: VideoSearchClient = {
      search: vi.fn().mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return video('abc123');
      }),
    };
    const finder = new VideoFinder(cache, search, logger, () => NOW);
    const names = Array.from({ length: MAX_VIDEO_SEARCHES_PER_RECIPE }, (_, i) => `technique ${i}`);

    const result = await finder.findForRecipe(recipeWith(names));

    expect(maxActive).toBe(MAX_VIDEO_SEARCHES_PER_RECIPE);
    expect(result.complete).toBe(true);
  });

  describe('time budget', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns what it has when the budget runs out, marks it incomplete, and caches late results', async () => {
      const search: VideoSearchClient = {
        search: vi.fn().mockImplementation((query: string) =>
          query === buildSearchQuery('fast')
            ? Promise.resolve(video('fast01'))
            : new Promise((resolve) => setTimeout(() => resolve(video('slow01')), 5000))
        ),
      };
      const finder = new VideoFinder(cache, search, logger, () => NOW, { budgetMs: 1000 });

      const pending = finder.findForRecipe(recipeWith(['Fast', 'Slow']));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result).toEqual({ videos: { Fast: video('fast01') }, complete: false });
      expect(logger.warn).toHaveBeenCalledWith('video_lookup_budget_exceeded', { budget_ms: 1000, unsettled: 1 });

      // The slow search still lands in the shared cache for the next visit.
      await vi.advanceTimersByTimeAsync(4000);
      expect(cache.entries.get('slow')?.video).toEqual(video('slow01'));
      const again = await finder.findForRecipe(recipeWith(['Fast', 'Slow']));
      expect(again).toEqual({ videos: { Fast: video('fast01'), Slow: video('slow01') }, complete: true });
      expect(search.search).toHaveBeenCalledTimes(2);
    });

    it('a hung search costs at most one budget, however many techniques there are', async () => {
      const search: VideoSearchClient = { search: vi.fn().mockImplementation(() => new Promise(() => {})) };
      const finder = new VideoFinder(cache, search, logger, () => NOW, { budgetMs: 2000 });
      const names = Array.from({ length: MAX_VIDEO_SEARCHES_PER_RECIPE }, (_, i) => `technique ${i}`);

      let done = false;
      const pending = finder.findForRecipe(recipeWith(names)).then((r) => {
        done = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ videos: {}, complete: false });
      expect(search.search).toHaveBeenCalledTimes(MAX_VIDEO_SEARCHES_PER_RECIPE);
    });
  });

  it('cache errors never fail the recipe', async () => {
    const brokenCache = {
      getMany: vi.fn().mockRejectedValue(new Error('db down')),
      put: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const search = searchReturning({ 'dice onion': video('abc123') });
    const finder = new VideoFinder(brokenCache, search, logger, () => NOW);

    expect(await finder.findForRecipe(recipeWith(['Dice onion']))).toEqual({
      videos: { 'Dice onion': video('abc123') },
      complete: true,
    });
  });

  it('no techniques: no searches', async () => {
    const search = searchReturning({});
    const finder = new VideoFinder(cache, search, logger, () => NOW);
    expect(await finder.findForRecipe(recipeWith([undefined, '   ']))).toEqual({ videos: {}, complete: true });
    expect(search.search).not.toHaveBeenCalled();
  });
});

describe('YouTubeSearchClient', () => {
  const mockFetch = vi.fn();
  const API_KEY = 'test-youtube-key';

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs one safe, embeddable, single-result search', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'How to dice', channelTitle: 'Chef' } }],
        }),
    });
    const client = new YouTubeSearchClient({ apiKey: API_KEY });

    const result = await client.search('how to dice onion beginner cooking');

    expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', title: 'How to dice', channelTitle: 'Chef' });
    const url = new URL((mockFetch.mock.calls[0] as [string])[0]);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      part: 'snippet',
      type: 'video',
      maxResults: '1',
      safeSearch: 'strict',
      videoEmbeddable: 'true',
      q: 'how to dice onion beginner cooking',
      key: API_KEY,
    });
  });

  it('returns null when there are no results', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ items: [] }) });
    expect(await new YouTubeSearchClient({ apiKey: API_KEY }).search('q')).toBeNull();
  });

  it('reports status and reason, never the key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
    });
    const error = await new YouTubeSearchClient({ apiKey: API_KEY }).search('q').catch((e: Error) => e);
    expect((error as Error).message).toBe('YouTube search failed: 403 quotaExceeded');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('times out', async () => {
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(new YouTubeSearchClient({ apiKey: API_KEY, timeoutMs: 20 }).search('q')).rejects.toThrow(
      'YouTube search timed out after 20ms'
    );
  });
});

describe('SupabaseTechniqueVideoCache', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads many keys with a quoted in.() filter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            {
              technique_key: 'dice onion',
              search_query: 'how to dice onion beginner cooking',
              video_id: 'abc123',
              video_title: 'T',
              channel_title: null,
              fetched_at: '2026-11-15T12:00:00Z',
            },
          ])
        ),
    });
    const cache = new SupabaseTechniqueVideoCache({ url: 'https://p.supabase.co', serviceRoleKey: 'k' });

    const result = await cache.getMany(['dice onion', 'say "hi", ok']);

    const url = new URL((mockFetch.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/rest/v1/technique_videos');
    expect(url.searchParams.get('technique_key')).toBe('in.("dice onion","say \\"hi\\", ok")');
    expect(result.get('dice onion')?.video).toEqual({ videoId: 'abc123', title: 'T' });
  });

  it('upserts an entry, including a cached miss', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') });
    const cache = new SupabaseTechniqueVideoCache({ url: 'https://p.supabase.co', serviceRoleKey: 'k' });

    await cache.put({ techniqueKey: 'x', searchQuery: 'q', video: null, fetchedAt: NOW });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://p.supabase.co/rest/v1/technique_videos');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(init.body as string)).toEqual([
      {
        technique_key: 'x',
        search_query: 'q',
        video_id: null,
        video_title: null,
        channel_title: null,
        fetched_at: NOW.toISOString(),
      },
    ]);
  });
});
