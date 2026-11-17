/**
 * Cook anything dish photos (Wikimedia Commons).
 *
 * When a free-form recipe is generated, look up one still photo of the dish:
 *   1. Read the shared cache (dish_photos), keyed by normalizeDishName.
 *   2. On a miss, search Wikimedia Commons (no API key). Try the dish name,
 *      then a more specific query (for example "pho", then "pho soup", then
 *      "Vietnamese pho"). Accept only CC0, Public Domain, CC BY, or CC BY-SA
 *      (any version). Reject NC, ND, fair use, and everything else. Image
 *      URLs must be https://upload.wikimedia.org raster files (jpeg/png/webp).
 *      Commons often returns the sized image on thumb.wikimedia.org; that host
 *      is rewritten to upload.wikimedia.org and dropped if it still isn't a
 *      raster there. The original upload URL is used when the thumb isn't.
 *   3. Cache a found photo, and cache a genuine "no photo" miss with a TTL so
 *      repeated misses don't hammer Commons. Timeouts and other transient
 *      errors are not cached (an in-memory cooldown avoids a burst).
 *   4. A failure, timeout, or miss returns photo: null. Recipe generation
 *      always succeeds.
 */
import { z } from 'zod';
import { rememberUntil } from './cooldown-map.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';

export const WIKIMEDIA_USER_AGENT =
  'SimmerApp/0.1 (JMU AI Club student project; https://github.com/trentderosa/Ai-Club-Simmer)';
export const WIKIMEDIA_UPLOAD_HOST = 'upload.wikimedia.org';
export const WIKIMEDIA_THUMB_HOST = 'thumb.wikimedia.org';
export const WIKIMEDIA_COMMONS_HOST = 'commons.wikimedia.org';
export const DEFAULT_DISH_PHOTO_TIMEOUT_MS = 2500;
export const DISH_PHOTO_TIMEOUT_MS = { default: 2500, min: 500, max: 10000 } as const;
/** Re-try a cached "no photo" miss after this long. Found photos are kept. */
export const DISH_PHOTO_NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** In-memory pause after a timeout or error so a cached-recipe hit doesn't call Commons again immediately. */
export const DISH_PHOTO_ERROR_COOLDOWN_MS = 60_000;
/** Stop trying broader queries once a title scores at least this well. */
export const DISH_PHOTO_GOOD_MATCH_SCORE = 13;
/** Artist names are drawn on a 330px hero; longer strings are clipped with an ellipsis. */
export const MAX_PHOTO_AUTHOR_LENGTH = 80;
export const DISH_PHOTO_THUMB_WIDTH = 1200;
const ALLOWED_RASTER_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const ALLOWED_RASTER_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export interface DishPhotoCredit {
  author: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
}

export interface DishPhoto {
  url: string;
  credit: DishPhotoCredit;
}

export interface DishPhotoLookupResult {
  photo: DishPhoto | null;
  /**
   * True when we have a definite answer (a photo or a genuine miss).
   * False when the lookup failed, timed out, or the cache was unavailable
   * and we couldn't confirm a result: don't persist it as final.
   */
  complete: boolean;
}

export interface CachedDishPhoto {
  normalizedDishName: string;
  photo: DishPhoto | null;
  fetchedAt: Date;
}

export interface DishPhotoCache {
  get(normalizedDishName: string): Promise<CachedDishPhoto | null>;
  put(entry: CachedDishPhoto): Promise<void>;
}

export interface DishPhotoSearchClient {
  /** Best allowed photo for the dish, or null when nothing acceptable was found. */
  search(dishName: string): Promise<DishPhoto | null>;
}

export interface DishPhotoFinderLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export interface DishPhotoFinderOptions {
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decode a few common entities and strip tags from Commons extmetadata HTML. */
export function stripAttributionHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clipAttribution(author: string, max = MAX_PHOTO_AUTHOR_LENGTH): string {
  const trimmed = author.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function foldedLicenseText(shortName: string, license?: string): string {
  return `${shortName} ${license ?? ''}`
    .toLowerCase()
    .replace(/[_./]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Accept only CC0, clearly marked public domain / PD, CC BY, or CC BY-SA
 * (any version). Reject NC, ND, fair use, and anything else.
 */
export function isAllowedCommonsLicense(shortName: string, license?: string): boolean {
  const raw = foldedLicenseText(shortName, license);
  if (!raw) return false;
  if (
    /\b(nc|nd|noderiv|noderivs|noderivatives|noncommercial|non commercial)\b/.test(raw) ||
    /\bfair\s*use\b/.test(raw)
  ) {
    return false;
  }
  if (/\bcc0\b/.test(raw) || /\bcreative commons zero\b/.test(raw) || /\bcc zero\b/.test(raw)) {
    return true;
  }
  if (/\bpublic domain\b/.test(raw) || /\bpdm\b/.test(raw) || /(^|\s)pd(\s|$)/.test(raw)) {
    return true;
  }
  if (/\bcc\s+by\s+sa\b/.test(raw)) return true;
  if (/\bcc\s+by\b/.test(raw)) return true;
  return false;
}

function extensionOf(pathname: string): string {
  const base = pathname.toLowerCase().split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

const TITLE_REJECT = /\b(menu|logo|icon|map|flag|diagram|poster|banner|qr code|coat of arms)\b/i;
const TITLE_FOOD = /\b(soup|bowl|noodle|noodles|plate|stew|salad|curry|roast|sandwich|pasta|rice|pizza)\b/i;
const TITLE_SKIP_TOKENS = new Set(['and', 'with', 'the', 'for']);

/**
 * Extra Commons queries for a whole dish name, after the name itself.
 * Add the next special case here instead of another branch in dishPhotoQueries.
 */
export const DISH_PHOTO_QUERY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  pho: ['pho soup', 'vietnamese pho'],
};

/** Token expansions tried when the expanded word isn't already in the name. */
export const DISH_PHOTO_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  parm: 'parmesan',
};

/**
 * Queries to try, most specific last, at most three. "pho" becomes
 * "pho", "pho soup", "vietnamese pho". "chicken parm" also tries
 * "chicken parmesan". Other single-word names try "soup" and "dish".
 */
export function dishPhotoQueries(dishName: string): string[] {
  const name = dishName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return [];
  const queries = [name];
  const aliases = DISH_PHOTO_QUERY_ALIASES[name];
  if (aliases) {
    queries.push(...aliases);
  } else {
    let expanded = name;
    for (const [token, replacement] of Object.entries(DISH_PHOTO_TOKEN_ALIASES)) {
      if (!new RegExp(`\\b${token}\\b`).test(expanded)) continue;
      if (new RegExp(`\\b${replacement}\\b`).test(expanded)) continue;
      expanded = expanded.replace(new RegExp(`\\b${token}\\b`, 'g'), replacement);
    }
    if (expanded !== name) {
      queries.push(expanded);
    } else if (!name.includes(' ') && !/\b(soup|stew|salad|bowl)\b/.test(name)) {
      queries.push(`${name} soup`, `${name} dish`);
    }
  }
  return [...new Set(queries)].slice(0, 3);
}

/**
 * Higher is a better title for this dish. -1 means never use it (a menu,
 * logo, map, and so on). 0 means the license may be fine but the file title
 * doesn't name the dish, so it is only a fallback.
 */
export function dishTitleScore(title: string, dishName: string): number {
  const file = title
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/_+/g, ' ')
    .toLowerCase();
  if (!file.trim() || TITLE_REJECT.test(file)) return -1;
  const tokens = dishName
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !TITLE_SKIP_TOKENS.has(token));
  if (tokens.length === 0 || !tokens.every((token) => file.includes(token))) return 0;
  let score = 10;
  if (TITLE_FOOD.test(file)) score += 3;
  if (/\b(mise|ingredients?|uncooked)\b/.test(file)) score -= 4;
  const first = file.indexOf(tokens[0]);
  if (first >= 0 && first < 16) score += 2;
  return score;
}

/** Rewrite a Commons thumb CDN URL onto upload.wikimedia.org and drop trackers. */
export function rewriteCommonsImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    const host = url.hostname.toLowerCase();
    if (host !== WIKIMEDIA_UPLOAD_HOST && host !== WIKIMEDIA_THUMB_HOST) return null;
    if (host === WIKIMEDIA_THUMB_HOST) url.hostname = WIKIMEDIA_UPLOAD_HOST;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Prefer a sized thumb when it is a raster on upload.wikimedia.org (rewriting
 * thumb.wikimedia.org). Otherwise use the original file when that is allowed.
 * Mime is the original file's type, so it is only applied to the original URL.
 */
export function commonsDisplayUrl(thumburl: string | undefined, originalUrl: string | undefined, mime?: string): string | null {
  if (thumburl) {
    const thumb = rewriteCommonsImageUrl(thumburl);
    if (thumb && isAllowedImageUrl(thumb)) return thumb;
  }
  if (originalUrl) {
    const original = rewriteCommonsImageUrl(originalUrl);
    if (original && isAllowedImageUrl(original, mime)) return original;
  }
  return null;
}

/** https license URL. Commons still emits http://creativecommons.org deeds; those are upgraded. */
export function canonicalLicenseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username !== '' || url.password !== '') return null;
    const host = url.hostname.toLowerCase();
    const creativeCommons = host === 'creativecommons.org' || host.endsWith('.creativecommons.org');
    if (url.protocol === 'http:' && creativeCommons) url.protocol = 'https:';
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isAllowedImageUrl(raw: string, mime?: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (url.username !== '' || url.password !== '') return false;
    if (url.hostname.toLowerCase() !== WIKIMEDIA_UPLOAD_HOST) return false;
    if (mime && !ALLOWED_RASTER_MIME.has(mime.toLowerCase())) return false;
    return ALLOWED_RASTER_EXT.has(extensionOf(url.pathname));
  } catch {
    return false;
  }
}

export function isAllowedCommonsFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (url.username !== '' || url.password !== '') return false;
    if (url.hostname.toLowerCase() !== WIKIMEDIA_COMMONS_HOST) return false;
    if (url.pathname.includes('/wiki/Special:Redirect') || url.pathname.toLowerCase().includes('/redirect')) {
      return false;
    }
    return url.pathname.startsWith('/wiki/File:') || url.pathname.startsWith('/wiki/File%3A');
  } catch {
    return false;
  }
}

export function commonsFileUrlFromTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const withPrefix = trimmed.startsWith('File:') ? trimmed : `File:${trimmed}`;
  const url = `https://${WIKIMEDIA_COMMONS_HOST}/wiki/${withPrefix.replace(/ /g, '_')}`;
  return isAllowedCommonsFileUrl(url) ? url : null;
}

export class DishPhotoFinder {
  private readonly inFlight = new Map<string, Promise<DishPhotoLookupResult>>();
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly cache: DishPhotoCache,
    private readonly search: DishPhotoSearchClient,
    private readonly logger: DishPhotoFinderLogger = console,
    private readonly now: () => Date = (): Date => new Date()
  ) {}

  async findForDish(normalizedDishName: string): Promise<DishPhotoLookupResult> {
    const key = normalizedDishName.trim();
    if (!key) return { photo: null, complete: true };

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const work = this.lookup(key);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async lookup(key: string): Promise<DishPhotoLookupResult> {
    let cached: CachedDishPhoto | null = null;
    try {
      cached = await this.cache.get(key);
    } catch (error) {
      this.logger.warn('dish_photo_cache_read_failed', { error: errorMessage(error) });
    }

    if (
      cached &&
      (cached.photo || this.now().getTime() - cached.fetchedAt.getTime() < DISH_PHOTO_NEGATIVE_CACHE_TTL_MS)
    ) {
      return { photo: cached.photo, complete: true };
    }

    const nowMs = this.now().getTime();
    const cooldownUntil = this.retryAfter.get(key);
    if (cooldownUntil !== undefined && nowMs < cooldownUntil) {
      return { photo: null, complete: false };
    }

    let photo: DishPhoto | null;
    try {
      photo = await this.search.search(key);
    } catch (error) {
      this.logger.warn('dish_photo_search_failed', { dish: key, error: errorMessage(error) });
      rememberUntil(this.retryAfter, key, nowMs + DISH_PHOTO_ERROR_COOLDOWN_MS, nowMs);
      return { photo: null, complete: false };
    }

    this.retryAfter.delete(key);
    try {
      await this.cache.put({ normalizedDishName: key, photo, fetchedAt: this.now() });
    } catch (error) {
      this.logger.warn('dish_photo_cache_write_failed', { dish: key, error: errorMessage(error) });
    }
    return { photo, complete: true };
  }
}

// ---------------------------------------------------------------------------
// Wikimedia Commons MediaWiki API
// ---------------------------------------------------------------------------

export interface WikimediaCommonsClientConfig {
  timeoutMs?: number;
  baseUrl?: string;
  userAgent?: string;
  fetchFn?: typeof fetch;
}

const ExtValueSchema = z
  .object({ value: z.union([z.string(), z.number()]).optional() })
  .passthrough();

const ImageInfoSchema = z.object({
  url: z.string().optional(),
  thumburl: z.string().optional(),
  descriptionurl: z.string().optional(),
  mime: z.string().optional(),
  extmetadata: z
    .object({
      Artist: ExtValueSchema.optional(),
      LicenseShortName: ExtValueSchema.optional(),
      License: ExtValueSchema.optional(),
      LicenseUrl: ExtValueSchema.optional(),
    })
    .passthrough()
    .optional(),
});

const CommonsSearchResponseSchema = z.object({
  query: z
    .object({
      pages: z.record(z.string(), z.object({
        title: z.string().optional(),
        index: z.number().optional(),
        imageinfo: z.array(ImageInfoSchema).optional(),
      })).optional(),
    })
    .optional(),
});

/**
 * generator=search stores pages keyed by pageid. Integer-like keys are
 * enumerated in numeric order, which is upload age, not relevance. Sort by
 * the search `index` (1 is the best hit) before picking a photo.
 */
export function pagesInSearchOrder<T extends { index?: number }>(pages: Record<string, T>): T[] {
  return Object.values(pages).sort(
    (a, b) => (a.index ?? Number.POSITIVE_INFINITY) - (b.index ?? Number.POSITIVE_INFINITY)
  );
}

function extString(value: { value?: string | number } | undefined): string {
  if (value?.value === undefined || value.value === null) return '';
  return String(value.value).trim();
}

export function photoFromCommonsPage(
  title: string | undefined,
  info: z.infer<typeof ImageInfoSchema> | undefined
): DishPhoto | null {
  if (!info) return null;
  const shortName = extString(info.extmetadata?.LicenseShortName);
  const license = extString(info.extmetadata?.License);
  if (!isAllowedCommonsLicense(shortName, license)) return null;

  const candidateUrl = commonsDisplayUrl(info.thumburl, info.url, info.mime);
  if (!candidateUrl) return null;

  const folded = foldedLicenseText(shortName, license);
  const isPublicDomain =
    /\bcc0\b/.test(folded) ||
    /\bpublic domain\b/.test(folded) ||
    /\bpdm\b/.test(folded) ||
    /(^|\s)pd(\s|$)/.test(folded);
  const licenseUrl = canonicalLicenseUrl(
    extString(info.extmetadata?.LicenseUrl) ||
      (isPublicDomain
        ? /\bcc0\b/.test(folded)
          ? 'https://creativecommons.org/publicdomain/zero/1.0/'
          : 'https://creativecommons.org/publicdomain/mark/1.0/'
        : '')
  );
  if (!licenseUrl) return null;

  const sourceUrl =
    (info.descriptionurl && isAllowedCommonsFileUrl(info.descriptionurl) ? info.descriptionurl : null) ??
    (title ? commonsFileUrlFromTitle(title) : null);
  if (!sourceUrl) return null;

  const author = clipAttribution(stripAttributionHtml(extString(info.extmetadata?.Artist)));
  const resolvedAuthor = author || (isPublicDomain ? 'Wikimedia Commons' : '');
  if (!resolvedAuthor) return null;

  return {
    url: candidateUrl,
    credit: {
      author: resolvedAuthor,
      license: shortName || license,
      licenseUrl,
      sourceUrl,
    },
  };
}

type CommonsPage = {
  title?: string;
  index?: number;
  imageinfo?: z.infer<typeof ImageInfoSchema>[];
};

export class WikimediaCommonsClient implements DishPhotoSearchClient {
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: WikimediaCommonsClientConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_DISH_PHOTO_TIMEOUT_MS;
    this.baseUrl = config.baseUrl ?? 'https://commons.wikimedia.org/w/api.php';
    this.userAgent = config.userAgent ?? WIKIMEDIA_USER_AGENT;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  buildUrl(dishName: string): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrsearch', `${dishName} filetype:bitmap`);
    url.searchParams.set('gsrlimit', '10');
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|extmetadata|mime');
    url.searchParams.set('iiurlwidth', String(DISH_PHOTO_THUMB_WIDTH));
    return url.toString();
  }

  async search(dishName: string): Promise<DishPhoto | null> {
    const queries = dishPhotoQueries(dishName);
    if (queries.length === 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const picked: { best: { photo: DishPhoto; score: number; queryIndex: number } | null } = { best: null };
      for (const [queryIndex, query] of queries.entries()) {
        let pages: CommonsPage[];
        try {
          pages = await this.fetchPages(query, controller.signal);
        } catch (error) {
          if (picked.best) return picked.best.photo;
          throw error;
        }
        for (const page of pages) {
          const score = dishTitleScore(page.title ?? '', dishName);
          if (score < 0) continue;
          const photo = photoFromCommonsPage(page.title, page.imageinfo?.[0]);
          if (!photo) continue;
          const best = picked.best;
          const better = !best || score > best.score;
          const moreSpecificTie =
            best !== null && score === best.score && score > 0 && queryIndex > best.queryIndex;
          if (better || moreSpecificTie) picked.best = { photo, score, queryIndex };
        }
        if (picked.best && picked.best.score >= DISH_PHOTO_GOOD_MATCH_SCORE) break;
      }
      return picked.best?.photo ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchPages(query: string, signal: AbortSignal): Promise<CommonsPage[]> {
    const response = await this.fetchFn(this.buildUrl(query), {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Api-User-Agent': this.userAgent,
        Accept: 'application/json',
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Wikimedia Commons search failed: ${response.status}`);
    }
    const parsed = CommonsSearchResponseSchema.parse(await response.json());
    return pagesInSearchOrder(parsed.query?.pages ?? {});
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const CacheRowSchema = z.object({
  normalized_dish_name: z.string(),
  image_url: z.string().nullable(),
  author: z.string().nullable(),
  license: z.string().nullable(),
  license_url: z.string().nullable(),
  source_url: z.string().nullable(),
  fetched_at: z.string(),
});

function photoFromRow(row: z.infer<typeof CacheRowSchema>): DishPhoto | null {
  if (!row.image_url || !row.author || !row.license || !row.license_url || !row.source_url) {
    return null;
  }
  if (!isAllowedImageUrl(row.image_url) || !isAllowedCommonsFileUrl(row.source_url)) {
    return null;
  }
  return {
    url: row.image_url,
    credit: {
      author: row.author,
      license: row.license,
      licenseUrl: row.license_url,
      sourceUrl: row.source_url,
    },
  };
}

/** dish_photos table (service role only). */
export class SupabaseDishPhotoCache implements DishPhotoCache {
  private readonly rest: SupabaseRest;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async get(normalizedDishName: string): Promise<CachedDishPhoto | null> {
    const rows = await this.rest.select<unknown>('dish_photos', {
      select: 'normalized_dish_name,image_url,author,license,license_url,source_url,fetched_at',
      normalized_dish_name: `eq.${normalizedDishName}`,
      limit: '1',
    });
    const raw = rows[0];
    if (!raw) return null;
    const row = CacheRowSchema.parse(raw);
    return {
      normalizedDishName: row.normalized_dish_name,
      photo: photoFromRow(row),
      fetchedAt: new Date(row.fetched_at),
    };
  }

  async put(entry: CachedDishPhoto): Promise<void> {
    await this.rest.upsert('dish_photos', [
      {
        normalized_dish_name: entry.normalizedDishName,
        image_url: entry.photo?.url ?? null,
        author: entry.photo?.credit.author ?? null,
        license: entry.photo?.credit.license ?? null,
        license_url: entry.photo?.credit.licenseUrl ?? null,
        source_url: entry.photo?.credit.sourceUrl ?? null,
        fetched_at: entry.fetchedAt.toISOString(),
      },
    ]);
  }
}

/** Dev / test cache (lost on restart). */
export class InMemoryDishPhotoCache implements DishPhotoCache {
  readonly entries = new Map<string, CachedDishPhoto>();

  get(normalizedDishName: string): Promise<CachedDishPhoto | null> {
    return Promise.resolve(this.entries.get(normalizedDishName) ?? null);
  }

  put(entry: CachedDishPhoto): Promise<void> {
    this.entries.set(entry.normalizedDishName, entry);
    return Promise.resolve();
  }
}
