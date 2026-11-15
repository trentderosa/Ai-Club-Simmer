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

    const videos = await finder.findForRecipe(recipeWith(['Dice onion', undefined, 'dice  onion', 'Whisk eggs']));

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
    expect(second).toEqual({ 'DICE ONION': video('abc123') });
  });

  it('caches "no result" and retries it only after the TTL', async () => {
    const search = searchReturning({});
    let now = NOW;
    const finder = new VideoFinder(cache, search, logger, () => now);

    expect(await finder.findForRecipe(recipeWith(['obscure move']))).toEqual({});
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

    const videos = await finder.findForRecipe(recipeWith(['Dice onion', 'Whisk eggs']));

    expect(videos).toEqual({ 'Whisk eggs': video('def456') });
    expect(cache.entries.has('dice onion')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('video_search_failed', {
      technique: 'dice onion',
      error: 'YouTube search failed: 403 quotaExceeded',
    });
  });

  it(`caps new searches at ${MAX_VIDEO_SEARCHES_PER_RECIPE} per recipe`, async () => {
    const search: VideoSearchClient = { search: vi.fn().mockResolvedValue(video('abc123')) };
    const finder = new VideoFinder(cache, search, logger, () => NOW);
    const names = Array.from({ length: MAX_VIDEO_SEARCHES_PER_RECIPE + 3 }, (_, i) => `technique ${i}`);

    const videos = await finder.findForRecipe(recipeWith(names));

    expect(search.search).toHaveBeenCalledTimes(MAX_VIDEO_SEARCHES_PER_RECIPE);
    expect(Object.keys(videos)).toHaveLength(MAX_VIDEO_SEARCHES_PER_RECIPE);
  });

  it('cache errors never fail the recipe', async () => {
    const brokenCache = {
      getMany: vi.fn().mockRejectedValue(new Error('db down')),
      put: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const search = searchReturning({ 'dice onion': video('abc123') });
    const finder = new VideoFinder(brokenCache, search, logger, () => NOW);

    expect(await finder.findForRecipe(recipeWith(['Dice onion']))).toEqual({ 'Dice onion': video('abc123') });
  });

  it('no techniques: no searches', async () => {
    const search = searchReturning({});
    const finder = new VideoFinder(cache, search, logger, () => NOW);
    expect(await finder.findForRecipe(recipeWith([undefined, '   ']))).toEqual({});
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
