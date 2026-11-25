import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundLimiter } from './outbound-limiter.js';
import {
  DISH_PHOTO_ERROR_COOLDOWN_MS,
  DISH_PHOTO_NEGATIVE_CACHE_TTL_MS,
  MAX_PHOTO_AUTHOR_LENGTH,
  DishPhotoFinder,
  InMemoryDishPhotoCache,
  WikimediaCommonsClient,
  canonicalLicenseUrl,
  clipAttribution,
  commonsDisplayUrl,
  commonsFileUrlFromTitle,
  dishPhotoQueries,
  DISH_PHOTO_GOOD_MATCH_SCORE,
  dishTitleScore,
  isAllowedCommonsFileUrl,
  isAllowedCommonsLicense,
  isAllowedImageUrl,
  pagesInSearchOrder,
  photoFromCommonsPage,
  stripAttributionHtml,
  type DishPhoto,
  type DishPhotoSearchClient,
} from './dish-photo.js';

const PHOTO: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
  credit: {
    author: 'Jane Cook',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
  },
};

describe('isAllowedCommonsLicense', () => {
  it.each([
    ['CC0', undefined],
    ['CC0 1.0', 'cc-zero'],
    ['Creative Commons Zero', undefined],
    ['Public domain', undefined],
    ['PD', undefined],
    ['PD-US', 'pd'],
    ['Public Domain Mark', 'pdm'],
    ['CC BY 4.0', 'cc-by-4.0'],
    ['CC-BY-3.0', 'cc-by-3.0'],
    ['CC BY-SA 4.0', 'cc-by-sa-4.0'],
    ['CC-BY-SA-3.0', 'cc-by-sa-3.0'],
    ['CC BY-SA 2.5', undefined],
  ])('accepts %s', (shortName, license) => {
    expect(isAllowedCommonsLicense(shortName, license)).toBe(true);
  });

  it.each([
    ['CC BY-NC 4.0', 'cc-by-nc-4.0'],
    ['CC BY-NC-SA 3.0', undefined],
    ['CC BY-ND 2.0', 'cc-by-nd-2.0'],
    ['CC BY-NC-ND 4.0', undefined],
    ['Fair use', undefined],
    ['Fair Use', 'fairuse'],
    ['GNU Free Documentation License', 'gfdl'],
    ['Copyrighted', undefined],
    ['', undefined],
    ['Attribution', undefined],
  ])('rejects %s', (shortName, license) => {
    expect(isAllowedCommonsLicense(shortName, license)).toBe(false);
  });
});

describe('isAllowedImageUrl', () => {
  it('accepts https upload.wikimedia.org raster URLs', () => {
    expect(isAllowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg')).toBe(true);
    expect(
      isAllowedImageUrl(
        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Example.tif/1200px-Example.jpg',
        'image/jpeg'
      )
    ).toBe(true);
    expect(isAllowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/f/f1/Dish.png')).toBe(true);
    expect(isAllowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/f/f1/Dish.webp')).toBe(true);
  });

  it('rejects other hosts, schemes, credentials, and non-raster types', () => {
    expect(isAllowedImageUrl('http://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://evil.com/wikipedia/commons/a/a8/Example.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://upload.wikimedia.org.evil.com/a/a8/Example.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://user:pass@upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.svg')).toBe(false);
    expect(isAllowedImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg', 'image/svg+xml')).toBe(
      false
    );
    expect(isAllowedImageUrl('not a url')).toBe(false);
  });
});

describe('commons file URLs and attribution HTML', () => {
  it('accepts https Commons File pages and builds one from a title', () => {
    expect(isAllowedCommonsFileUrl('https://commons.wikimedia.org/wiki/File:Example.jpg')).toBe(true);
    expect(commonsFileUrlFromTitle('File:Example.jpg')).toBe(
      'https://commons.wikimedia.org/wiki/File:Example.jpg'
    );
    expect(isAllowedCommonsFileUrl('https://en.wikipedia.org/wiki/File:Example.jpg')).toBe(false);
    expect(isAllowedCommonsFileUrl('https://commons.wikimedia.org/wiki/Special:Redirect/file/Example.jpg')).toBe(
      false
    );
  });

  it('strips Artist HTML and clips long names', () => {
    expect(stripAttributionHtml('<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Cook</a>')).toBe(
      'Jane Cook'
    );
    expect(clipAttribution('Jane Cook')).toBe('Jane Cook');
    expect(clipAttribution('a'.repeat(MAX_PHOTO_AUTHOR_LENGTH))).toHaveLength(MAX_PHOTO_AUTHOR_LENGTH);
    const long = clipAttribution('a'.repeat(MAX_PHOTO_AUTHOR_LENGTH + 20));
    expect(long).toHaveLength(MAX_PHOTO_AUTHOR_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('photoFromCommonsPage', () => {
  const info = {
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
    thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Example.jpg/1200px-Example.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
    mime: 'image/jpeg',
    extmetadata: {
      Artist: { value: '<b>Jane Cook</b>' },
      LicenseShortName: { value: 'CC BY-SA 4.0' },
      License: { value: 'cc-by-sa-4.0' },
      LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    },
  };

  it('builds a photo from allowed metadata and prefers the thumb URL', () => {
    expect(photoFromCommonsPage('File:Example.jpg', info)).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Example.jpg/1200px-Example.jpg',
      credit: {
        author: 'Jane Cook',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
      },
    });
  });

  it('rejects a disallowed license even when the URL is valid', () => {
    expect(
      photoFromCommonsPage('File:Example.jpg', {
        ...info,
        extmetadata: {
          ...info.extmetadata,
          LicenseShortName: { value: 'CC BY-NC 4.0' },
          License: { value: 'cc-by-nc-4.0' },
        },
      })
    ).toBeNull();
  });
});

describe('DishPhotoFinder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a cache hit without searching', async () => {
    const cache = new InMemoryDishPhotoCache();
    await cache.put({ normalizedDishName: 'pad thai', photo: PHOTO, fetchedAt: new Date('2026-01-01') });
    const search: DishPhotoSearchClient = { search: vi.fn() };
    const finder = new DishPhotoFinder(cache, search);
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: PHOTO, complete: true });
    expect(search.search).not.toHaveBeenCalled();
  });

  it('stores a genuine miss and does not search again until the TTL expires', async () => {
    const cache = new InMemoryDishPhotoCache();
    const search: DishPhotoSearchClient = { search: vi.fn().mockResolvedValue(null) };
    let now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishPhotoFinder(cache, search, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('invisible stew')).resolves.toEqual({ photo: null, complete: true });
    expect(cache.entries.get('invisible stew')?.photo).toBeNull();
    await expect(finder.findForDish('invisible stew')).resolves.toEqual({ photo: null, complete: true });
    expect(search.search).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + DISH_PHOTO_NEGATIVE_CACHE_TTL_MS + 1);
    (search.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PHOTO);
    await expect(finder.findForDish('invisible stew')).resolves.toEqual({ photo: PHOTO, complete: true });
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(cache.entries.get('invisible stew')?.photo).toEqual(PHOTO);
  });

  it('honors a previously cached miss until the TTL expires', async () => {
    const cache = new InMemoryDishPhotoCache();
    const fetchedAt = new Date('2026-02-01T00:00:00.000Z');
    await cache.put({ normalizedDishName: 'pho', photo: null, fetchedAt });
    const search: DishPhotoSearchClient = { search: vi.fn().mockResolvedValue(PHOTO) };
    const fresh = new DishPhotoFinder(cache, search, { warn: vi.fn() }, () => fetchedAt);
    await expect(fresh.findForDish('pho')).resolves.toEqual({ photo: null, complete: true });
    expect(search.search).not.toHaveBeenCalled();

    const expired = new DishPhotoFinder(
      cache,
      search,
      { warn: vi.fn() },
      () => new Date(fetchedAt.getTime() + DISH_PHOTO_NEGATIVE_CACHE_TTL_MS + 1)
    );
    await expect(expired.findForDish('pho')).resolves.toEqual({ photo: PHOTO, complete: true });
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('does not cache a thrown search, and cools down retries for a minute', async () => {
    const cache = new InMemoryDishPhotoCache();
    const search: DishPhotoSearchClient = {
      search: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    let now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishPhotoFinder(cache, search, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(cache.entries.size).toBe(0);
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(search.search).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + DISH_PHOTO_ERROR_COOLDOWN_MS + 1);
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(cache.entries.size).toBe(0);
  });
});

describe('dish photo queries and display URLs', () => {
  it('tries a more specific query after the dish name', () => {
    expect(dishPhotoQueries('pho')).toEqual(['pho', 'pho soup', 'vietnamese pho']);
    expect(dishPhotoQueries('chicken parm')).toEqual(['chicken parm', 'chicken parmesan']);
    expect(dishPhotoQueries('chicken parmesan')).toEqual(['chicken parmesan']);
    expect(dishTitleScore('File:Menu of Pho 2025.jpg', 'pho')).toBe(-1);
    expect(dishTitleScore('File:Chicken parmesan.jpg', 'chicken parmesan')).toBeGreaterThan(
      dishTitleScore('File:Chicken parmesan mise en place.jpg', 'chicken parmesan')
    );
    expect(dishTitleScore('File:Soup - Pho Tau Bay.jpg', 'pho')).toBeGreaterThan(
      dishTitleScore('File:Sate Pho, Pho 21, Paris.jpg', 'pho')
    );
  });

  it('rewrites thumb.wikimedia.org onto upload.wikimedia.org and upgrades http license deeds', () => {
    expect(
      commonsDisplayUrl(
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Menu_of_Pho.jpg/1280px-Menu_of_Pho.jpg?utm_source=commons',
        'https://upload.wikimedia.org/wikipedia/commons/c/c4/Menu_of_Pho.jpg',
        'image/jpeg'
      )
    ).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Menu_of_Pho.jpg/1280px-Menu_of_Pho.jpg');
    expect(canonicalLicenseUrl('http://creativecommons.org/publicdomain/zero/1.0/deed.en')).toBe(
      'https://creativecommons.org/publicdomain/zero/1.0/deed.en'
    );
    expect(canonicalLicenseUrl('http://evil.example/license')).toBeNull();
  });

  it('accepts a Commons photo whose thumb host is not upload.wikimedia.org', () => {
    expect(
      photoFromCommonsPage('File:Pho.jpg', {
        url: 'https://upload.wikimedia.org/wikipedia/commons/c/c4/Pho.jpg',
        thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Pho.jpg/1280px-Pho.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Pho.jpg',
        mime: 'image/jpeg',
        extmetadata: {
          Artist: { value: 'Ada Cook' },
          LicenseShortName: { value: 'CC0' },
          LicenseUrl: { value: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' },
        },
      })
    ).toMatchObject({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Pho.jpg/1280px-Pho.jpg',
      credit: { license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/deed.en' },
    });
  });
});

describe('WikimediaCommonsClient timeout', () => {
  it('aborts a hung request and throws so the finder does not cache it', async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          const onAbort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }) as unknown as typeof fetch;

    const client = new WikimediaCommonsClient({ timeoutMs: 20, fetchFn });
    await expect(client.search('pad thai')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns the first allowed page and skips rejected licenses', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: (): Promise<unknown> => Promise.resolve({
        query: {
          pages: {
            '1': {
              title: 'File:Restricted.jpg',
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/wikipedia/commons/r/r1/Restricted.jpg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Restricted.jpg',
                  mime: 'image/jpeg',
                  extmetadata: {
                    Artist: { value: 'Nope' },
                    LicenseShortName: { value: 'CC BY-NC 4.0' },
                    License: { value: 'cc-by-nc-4.0' },
                    LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0/' },
                  },
                },
              ],
            },
            '2': {
              title: 'File:Example.jpg',
              imageinfo: [
                {
                  url: PHOTO.url,
                  descriptionurl: PHOTO.credit.sourceUrl,
                  mime: 'image/jpeg',
                  extmetadata: {
                    Artist: { value: PHOTO.credit.author },
                    LicenseShortName: { value: PHOTO.credit.license },
                    License: { value: 'cc-by-sa-4.0' },
                    LicenseUrl: { value: PHOTO.credit.licenseUrl },
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const client = new WikimediaCommonsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.search('pad thai')).resolves.toEqual({
      url: PHOTO.url,
      credit: PHOTO.credit,
    });
    const called = String(fetchFn.mock.calls[0][0]);
    expect(called).toContain('generator=search');
    expect(called).toContain('gsrnamespace=6');
    expect(called).toContain('iiprop=url');
    expect(fetchFn.mock.calls[0][1].headers['User-Agent']).toMatch(/SimmerApp\/0\.1/);
  });

  it('picks the best search hit, even when that page has a higher pageid', async () => {
    const better: DishPhoto = {
      url: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Better.jpg',
      credit: {
        author: 'Best Match',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Better.jpg',
      },
    };
    const worse: DishPhoto = {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Worse.jpg',
      credit: {
        author: 'Older Upload',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Worse.jpg',
      },
    };
    const pages = {
      '12': {
        title: 'File:Worse.jpg',
        index: 8,
        imageinfo: [
          {
            url: worse.url,
            descriptionurl: worse.credit.sourceUrl,
            mime: 'image/jpeg',
            extmetadata: {
              Artist: { value: worse.credit.author },
              LicenseShortName: { value: worse.credit.license },
              LicenseUrl: { value: worse.credit.licenseUrl },
            },
          },
        ],
      },
      '99': {
        title: 'File:Better.jpg',
        index: 1,
        imageinfo: [
          {
            url: better.url,
            descriptionurl: better.credit.sourceUrl,
            mime: 'image/jpeg',
            extmetadata: {
              Artist: { value: better.credit.author },
              LicenseShortName: { value: better.credit.license },
              LicenseUrl: { value: better.credit.licenseUrl },
            },
          },
        ],
      },
    };
    // Numeric object-key order would visit page 12 first.
    expect(Object.keys(pages)).toEqual(['12', '99']);
    expect(pagesInSearchOrder(pages).map((page) => page.index)).toEqual([1, 8]);

    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: (): Promise<unknown> => Promise.resolve({ query: { pages } }),
    });
    const client = new WikimediaCommonsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.search('chicken parm')).resolves.toEqual(better);
  });
});

describe('Commons outbound cap', () => {
  it('returns null without fetching, does not cache, and cools down when capped', async () => {
    const fetchFn = vi.fn();
    const limiter = new OutboundLimiter(1, 60_000, () => 0);
    expect(limiter.tryAcquire()).toBe(true); // use up the only slot
    const client = new WikimediaCommonsClient({ fetchFn: fetchFn as unknown as typeof fetch, limiter });
    const cache = new InMemoryDishPhotoCache();
    const warn = vi.fn();
    const now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishPhotoFinder(cache, client, { warn }, () => now);

    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('dish_photo_commons_rate_limited', { dish: 'pad thai' });

    // Per-dish cooldown applies: a repeat does not reach the client again.
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts each variant query as one outbound request', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const limiter = new OutboundLimiter(2, 60_000, () => 0);
    const client = new WikimediaCommonsClient({ fetchFn: fetchFn as unknown as typeof fetch, limiter });
    // A one-word dish with no alias expands to 3 queries; the 3rd hits the cap.
    expect(dishPhotoQueries('jollof')).toHaveLength(3);
    await expect(client.search('jollof')).rejects.toMatchObject({ name: 'CommonsRateLimitedError' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('drops a weak partial match when a later variant hits the cap, so nothing is cached', async () => {
    const weakPage = {
      title: 'File:Jollof.jpg',
      index: 1,
      imageinfo: [
        {
          url: 'https://upload.wikimedia.org/jollof.jpg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Jollof.jpg',
          mime: 'image/jpeg',
          extmetadata: {
            Artist: { value: 'Test Uploader' },
            LicenseShortName: { value: 'CC BY 4.0' },
            LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
          },
        },
      ],
    };
    // Found, but below the "good match" bar, so the client would try the next variant.
    expect(dishTitleScore(weakPage.title, 'jollof')).toBeGreaterThan(0);
    expect(dishTitleScore(weakPage.title, 'jollof')).toBeLessThan(DISH_PHOTO_GOOD_MATCH_SCORE);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ query: { pages: { '1': weakPage } } }),
    });
    const limiter = new OutboundLimiter(1, 60_000, () => 0);
    const client = new WikimediaCommonsClient({ fetchFn: fetchFn as unknown as typeof fetch, limiter });
    const cache = new InMemoryDishPhotoCache();
    const warn = vi.fn();
    const finder = new DishPhotoFinder(cache, client, { warn }, () => new Date('2026-02-01T00:00:00.000Z'));

    await expect(finder.findForDish('jollof')).resolves.toEqual({ photo: null, complete: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.entries.size).toBe(0);
    expect(warn).toHaveBeenCalledWith('dish_photo_commons_rate_limited', { dish: 'jollof' });
  });
});
