import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISH_VIDEO_ERROR_COOLDOWN_MS,
  DISH_VIDEO_NEGATIVE_CACHE_TTL_MS,
  DishVideoFinder,
  InMemoryDishVideoCache,
  YouTubeDishVideoClient,
  dishVideoSearchQuery,
  dishVideoTitleMatches,
  isYouTubeQuotaError,
  parseIsoDuration,
  selectDishVideos,
  youtubeQuotaResetAt,
  type DishVideoDetails,
  type DishVideoHit,
  type DishVideoSearchClient,
} from './dish-video-finder.js';

const SECRET = 'super-secret-youtube-key';

describe('parseIsoDuration', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseIsoDuration('PT3M')).toBe(180);
    expect(parseIsoDuration('PT20M')).toBe(1200);
    expect(parseIsoDuration('PT15M10S')).toBe(910);
    expect(parseIsoDuration('PT1H2M')).toBe(3720);
    expect(parseIsoDuration('P1D')).toBeNull();
  });
});

describe('selectDishVideos', () => {
  const hits: DishVideoHit[] = [
    { videoId: 'boilwater01', title: 'How to boil water', channelTitle: 'Basics' },
    { videoId: 'shortpho01', title: 'Pho in 30 seconds', channelTitle: 'Shorts' },
    { videoId: 'longpho001', title: 'Pho recipe, the long way', channelTitle: 'Slow' },
    { videoId: 'pholow0001', title: 'How to make pho', channelTitle: 'Home' },
    { videoId: 'phohigh001', title: 'Authentic pho recipe', channelTitle: 'Street' },
    { videoId: 'phomid0001', title: 'Chicken pho recipe', channelTitle: 'Weeknight' },
  ];
  const details = new Map<string, DishVideoDetails>([
    ['boilwater01', { durationSeconds: 600, viewCount: 9_000_000, embeddable: true }],
    ['shortpho01', { durationSeconds: 30, viewCount: 8_000_000, embeddable: true }],
    ['longpho001', { durationSeconds: 21 * 60, viewCount: 7_000_000, embeddable: true }],
    ['pholow0001', { durationSeconds: 8 * 60, viewCount: 1_000, embeddable: true }],
    ['phohigh001', { durationSeconds: 12 * 60, viewCount: 500_000, embeddable: true }],
    ['phomid0001', { durationSeconds: 10 * 60, viewCount: 40_000, embeddable: true }],
    ['notembed01', { durationSeconds: 10 * 60, viewCount: 999_999, embeddable: false }],
  ]);

  it('keeps embeddable 3–20 minute videos that name the dish, highest views first', () => {
    expect(dishVideoTitleMatches('How to boil water', 'pho')).toBe(false);
    expect(dishVideoSearchQuery('pho')).toBe('pho recipe');
    expect(selectDishVideos('pho', hits, details).map((video) => video.videoId)).toEqual([
      'phohigh001',
      'phomid0001',
      'pholow0001',
    ]);
  });

  it('requires every dish token, so chicken parmesan is not a water video', () => {
    const parm: DishVideoHit[] = [
      { videoId: 'parm000001', title: 'Chicken Parmesan recipe', channelTitle: 'Kitchen' },
      { videoId: 'boilwater01', title: 'How to boil water', channelTitle: 'Basics' },
    ];
    expect(selectDishVideos('chicken parmesan', parm, new Map([
      ['parm000001', { durationSeconds: 900, viewCount: 10, embeddable: true }],
      ['boilwater01', { durationSeconds: 600, viewCount: 10_000_000, embeddable: true }],
    ])).map((video) => video.videoId)).toEqual(['parm000001']);
  });
});

describe('DishVideoFinder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches a hit and does not search again', async () => {
    const cache = new InMemoryDishVideoCache();
    const search: DishVideoSearchClient = {
      search: vi.fn().mockResolvedValue([{ videoId: 'phohigh001', title: 'Authentic pho recipe' }]),
    };
    const finder = new DishVideoFinder(cache, search);
    await expect(finder.findForDish('Pho')).resolves.toEqual({
      videos: [{ videoId: 'phohigh001', title: 'Authentic pho recipe' }],
      complete: true,
    });
    await finder.findForDish('pho');
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(search.search).toHaveBeenCalledWith('pho');
  });

  it('caches an empty result, and does not cache a quota failure', async () => {
    const cache = new InMemoryDishVideoCache();
    const search: DishVideoSearchClient = { search: vi.fn().mockResolvedValue([]) };
    const now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishVideoFinder(cache, search, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('pho')).resolves.toEqual({ videos: [], complete: true });
    await finder.findForDish('pho');
    expect(search.search).toHaveBeenCalledTimes(1);

    const later = new Date(now.getTime() + DISH_VIDEO_NEGATIVE_CACHE_TTL_MS + 1);
    const expired = new DishVideoFinder(cache, search, { warn: vi.fn() }, () => later);
    await expired.findForDish('pho');
    expect(search.search).toHaveBeenCalledTimes(2);
  });

  it('cools a failed search so a second open does not hit YouTube', async () => {
    const failing: DishVideoSearchClient = {
      search: vi.fn().mockRejectedValue(new Error('YouTube search failed: 504 timeout')),
    };
    let now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishVideoFinder(new InMemoryDishVideoCache(), failing, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('pho')).resolves.toEqual({ videos: [], complete: false });
    await expect(finder.findForDish('pho')).resolves.toEqual({ videos: [], complete: false });
    expect(failing.search).toHaveBeenCalledTimes(1);

    await finder.findForDish('chicken parmesan');
    expect(failing.search).toHaveBeenCalledTimes(2);

    now = new Date(now.getTime() + DISH_VIDEO_ERROR_COOLDOWN_MS + 1);
    await finder.findForDish('pho');
    expect(failing.search).toHaveBeenCalledTimes(3);
  });

  it('stops all dish searches until the YouTube quota resets', async () => {
    const failing: DishVideoSearchClient = {
      search: vi.fn().mockRejectedValue(new Error('YouTube search failed: 403 quotaExceeded')),
    };
    let now = new Date('2026-02-01T00:00:00.000Z'); // 16:00 the previous day, Pacific
    const finder = new DishVideoFinder(new InMemoryDishVideoCache(), failing, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('pho')).resolves.toEqual({ videos: [], complete: false });
    await expect(finder.findForDish('pho')).resolves.toEqual({ videos: [], complete: false });
    await expect(finder.findForDish('chicken parmesan')).resolves.toEqual({ videos: [], complete: false });
    expect(failing.search).toHaveBeenCalledTimes(1);
    expect(isYouTubeQuotaError(new Error('YouTube search failed: 403 dailyLimitExceeded'))).toBe(true);

    const reset = youtubeQuotaResetAt(now);
    now = new Date(reset.getTime() - 1);
    await finder.findForDish('pad thai');
    expect(failing.search).toHaveBeenCalledTimes(1);

    now = reset;
    await finder.findForDish('pad thai');
    expect(failing.search).toHaveBeenCalledTimes(2);
  });
});

describe('youtubeQuotaResetAt', () => {
  it('returns the next midnight in America/Los_Angeles', () => {
    // 16:00 UTC on 1 Feb 2026 is 08:00 PST the same day.
    const reset = youtubeQuotaResetAt(new Date('2026-02-01T16:00:00.000Z'));
    expect(reset.toISOString()).toBe('2026-02-02T08:00:00.000Z');
  });

  it('skips to the following midnight after a Pacific midnight', () => {
    const justAfter = youtubeQuotaResetAt(new Date('2026-02-02T08:00:00.000Z'));
    expect(justAfter.toISOString()).toBe('2026-02-03T08:00:00.000Z');
  });
});

describe('YouTubeDishVideoClient', () => {

  it('searches for the dish recipe and sorts the detail response by views', async () => {
    const fetchFn = vi.fn((url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      const href = String(url);
      if (href.includes('/search')) {
        return Promise.resolve({
          ok: true,
          json: (): Promise<unknown> => Promise.resolve({
            items: [
              { id: { videoId: 'lowviews01' }, snippet: { title: 'Pho recipe at home', channelTitle: 'A' } },
              { id: { videoId: 'highviews1' }, snippet: { title: 'The pho recipe', channelTitle: 'B' } },
              { id: { videoId: 'boilwater1' }, snippet: { title: 'How to boil water', channelTitle: 'C' } },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: (): Promise<unknown> => Promise.resolve({
          items: [
            { id: 'lowviews01', contentDetails: { duration: 'PT8M' }, statistics: { viewCount: '20' }, status: { embeddable: true } },
            { id: 'highviews1', contentDetails: { duration: 'PT12M' }, statistics: { viewCount: '20000' }, status: { embeddable: true } },
            { id: 'boilwater1', contentDetails: { duration: 'PT8M' }, statistics: { viewCount: '999999' }, status: { embeddable: true } },
          ],
        }),
      });
    });
    const client = new YouTubeDishVideoClient({
      apiKey: SECRET,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.search('pho')).resolves.toEqual([
      { videoId: 'highviews1', title: 'The pho recipe', channelTitle: 'B' },
      { videoId: 'lowviews01', title: 'Pho recipe at home', channelTitle: 'A' },
    ]);
    const searchUrl = new URL(String(fetchFn.mock.calls[0][0]));
    expect(searchUrl.searchParams.get('q')).toBe('pho recipe');
    expect(searchUrl.searchParams.get('safeSearch')).toBe('strict');
    expect(searchUrl.searchParams.get('videoEmbeddable')).toBe('true');
    expect(searchUrl.searchParams.get('type')).toBe('video');
    expect(searchUrl.searchParams.get('key')).toBe(SECRET);
    const videosUrl = new URL(String(fetchFn.mock.calls[1][0]));
    expect(videosUrl.searchParams.get('part')).toBe('contentDetails,statistics,status');
    expect(videosUrl.searchParams.get('id')).toBe('lowviews01,highviews1,boilwater1');
  });

  it('reports quota failures without the API key or the request URL', async () => {
    const fetchFn = vi.fn((): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: (): Promise<unknown> => Promise.resolve({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
      })
    );
    const client = new YouTubeDishVideoClient({
      apiKey: SECRET,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.search('pho')).rejects.toThrow('YouTube search failed: 403 quotaExceeded');
    try {
      await client.search('chicken parmesan');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('googleapis.com');
      expect(message).not.toContain('key=');
    }
  });
});
