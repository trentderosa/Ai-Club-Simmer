import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISH_PHOTO_NEGATIVE_CACHE_TTL_MS,
  DishPhotoFinder,
  InMemoryDishPhotoCache,
  WikimediaCommonsClient,
  commonsFileUrlFromTitle,
  isAllowedCommonsFileUrl,
  isAllowedCommonsLicense,
  isAllowedImageUrl,
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

  it('strips Artist HTML', () => {
    expect(stripAttributionHtml('<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Cook</a>')).toBe(
      'Jane Cook'
    );
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

  it('caches a genuine miss and does not search again until the TTL expires', async () => {
    const cache = new InMemoryDishPhotoCache();
    const search: DishPhotoSearchClient = { search: vi.fn().mockResolvedValue(null) };
    const now = new Date('2026-02-01T00:00:00.000Z');
    const finder = new DishPhotoFinder(cache, search, { warn: vi.fn() }, () => now);
    await expect(finder.findForDish('invisible stew')).resolves.toEqual({ photo: null, complete: true });
    await expect(finder.findForDish('invisible stew')).resolves.toEqual({ photo: null, complete: true });
    expect(search.search).toHaveBeenCalledTimes(1);

    const later = new Date(now.getTime() + DISH_PHOTO_NEGATIVE_CACHE_TTL_MS + 1);
    const expired = new DishPhotoFinder(cache, search, { warn: vi.fn() }, () => later);
    (search.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PHOTO);
    await expect(expired.findForDish('invisible stew')).resolves.toEqual({ photo: PHOTO, complete: true });
    expect(search.search).toHaveBeenCalledTimes(2);
  });

  it('does not cache a thrown search and reports an incomplete result', async () => {
    const cache = new InMemoryDishPhotoCache();
    const search: DishPhotoSearchClient = {
      search: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const finder = new DishPhotoFinder(cache, search, { warn: vi.fn() });
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(cache.entries.size).toBe(0);
    await expect(finder.findForDish('pad thai')).resolves.toEqual({ photo: null, complete: false });
    expect(search.search).toHaveBeenCalledTimes(2);
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
});
