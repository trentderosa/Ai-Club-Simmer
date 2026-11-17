/**
 * Dish recipe videos ("Watch someone make it").
 *
 * One YouTube search per normalized dish name ("{dish} recipe"), then a
 * videos.list call for duration and view count. Keep 1–3 embeddable videos
 * that are about 3–20 minutes, prefer higher view counts, and require the
 * title to name the dish so a technique video ("how to boil water") is not
 * shown as the dish.
 *
 * Results, including a genuine empty set, are cached in dish_videos. A
 * failure (no key, quota, network, timeout) is not cached and the section
 * is hidden. The API key stays in this process; errors never include the
 * request URL.
 */
import { z } from 'zod';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import { isYouTubeVideoId, youtubeWatchUrl } from '../cook-anything/youtube-url.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';

export interface DishVideo {
  videoId: string;
  title: string;
  channelTitle?: string;
  /** Allowlisted watch URL, added when the video is returned to the app. */
  url?: string;
}

export interface DishVideoLookupResult {
  videos: DishVideo[];
  /** False when the search failed. A genuine empty result is complete. */
  complete: boolean;
}

export interface CachedDishVideos {
  normalizedDishName: string;
  searchQuery: string;
  videos: DishVideo[];
  fetchedAt: Date;
}

export interface DishVideoCache {
  get(normalizedDishName: string): Promise<CachedDishVideos | null>;
  put(entry: CachedDishVideos): Promise<void>;
}

export interface DishVideoSearchClient {
  /** Matching videos, or an empty list when nothing acceptable was found. */
  search(dishName: string): Promise<DishVideo[]>;
}

export interface DishVideoFinderLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export const DISH_VIDEO_MIN_SECONDS = 3 * 60;
export const DISH_VIDEO_MAX_SECONDS = 20 * 60;
export const DISH_VIDEO_LIMIT = 3;
export const DISH_VIDEO_SEARCH_COUNT = 10;
/** Re-try a cached empty result after this long. Found videos are kept. */
export const DISH_VIDEO_NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_SKIP_TOKENS = new Set(['and', 'with', 'the', 'for']);
const MAX_TITLE_LENGTH = 200;

export function dishVideoSearchQuery(dishName: string): string {
  return `${dishName} recipe`;
}

/** ISO-8601 duration from YouTube contentDetails (PT#H#M#S). */
export function parseIsoDuration(value: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3]) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function dishVideoTitleMatches(title: string, dishName: string): boolean {
  const tokens = dishName
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !TITLE_SKIP_TOKENS.has(token));
  if (tokens.length === 0) return false;
  const folded = title.toLowerCase();
  return tokens.every((token) => folded.includes(token));
}

export interface DishVideoHit {
  videoId: string;
  title: string;
  channelTitle?: string;
}

export interface DishVideoDetails {
  durationSeconds: number;
  viewCount: number;
  embeddable: boolean;
}

/** Filter to embeddable 3–20 minute videos whose titles name the dish, highest view count first. */
export function selectDishVideos(
  dishName: string,
  hits: readonly DishVideoHit[],
  details: ReadonlyMap<string, DishVideoDetails>
): DishVideo[] {
  const ranked: { video: DishVideo; viewCount: number; index: number }[] = [];
  hits.forEach((hit, index) => {
    if (!isYouTubeVideoId(hit.videoId) || !youtubeWatchUrl(hit.videoId)) return;
    if (!dishVideoTitleMatches(hit.title, dishName)) return;
    const detail = details.get(hit.videoId);
    if (!detail?.embeddable) return;
    if (detail.durationSeconds < DISH_VIDEO_MIN_SECONDS || detail.durationSeconds > DISH_VIDEO_MAX_SECONDS) return;
    const title = hit.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) return;
    ranked.push({
      index,
      viewCount: detail.viewCount,
      video: {
        videoId: hit.videoId,
        title,
        ...(hit.channelTitle?.trim() ? { channelTitle: hit.channelTitle.trim().slice(0, MAX_TITLE_LENGTH) } : {}),
      },
    });
  });
  ranked.sort((a, b) => b.viewCount - a.viewCount || a.index - b.index);
  const seen = new Set<string>();
  const videos: DishVideo[] = [];
  for (const row of ranked) {
    if (seen.has(row.video.videoId)) continue;
    seen.add(row.video.videoId);
    videos.push(row.video);
    if (videos.length >= DISH_VIDEO_LIMIT) break;
  }
  return videos;
}

export class DishVideoFinder {
  private readonly inFlight = new Map<string, Promise<DishVideoLookupResult>>();

  constructor(
    private readonly cache: DishVideoCache,
    private readonly search: DishVideoSearchClient,
    private readonly logger: DishVideoFinderLogger = console,
    private readonly now: () => Date = (): Date => new Date()
  ) {}

  async findForDish(dishName: string): Promise<DishVideoLookupResult> {
    const key = normalizeDishName(dishName).slice(0, 200);
    if (!key) return { videos: [], complete: true };
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

  private async lookup(key: string): Promise<DishVideoLookupResult> {
    let cached: CachedDishVideos | null = null;
    try {
      cached = await this.cache.get(key);
    } catch (error) {
      this.logger.warn('dish_video_cache_read_failed', { error: errorMessage(error) });
    }
    if (
      cached &&
      (cached.videos.length > 0 || this.now().getTime() - cached.fetchedAt.getTime() < DISH_VIDEO_NEGATIVE_CACHE_TTL_MS)
    ) {
      return { videos: cached.videos, complete: true };
    }

    const query = dishVideoSearchQuery(key);
    let videos: DishVideo[];
    try {
      videos = await this.search.search(key);
    } catch (error) {
      this.logger.warn('dish_video_search_failed', { dish: key, error: errorMessage(error) });
      return { videos: [], complete: false };
    }
    try {
      await this.cache.put({ normalizedDishName: key, searchQuery: query, videos, fetchedAt: this.now() });
    } catch (error) {
      this.logger.warn('dish_video_cache_write_failed', { dish: key, error: errorMessage(error) });
    }
    return { videos, complete: true };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// YouTube Data API v3
// ---------------------------------------------------------------------------

export interface YouTubeDishVideoConfig {
  apiKey: string;
  timeoutMs?: number;
  searchUrl?: string;
  videosUrl?: string;
  fetchFn?: typeof fetch;
}

const SearchItemSchema = z.object({
  id: z.object({ videoId: z.string().optional() }).optional(),
  snippet: z.object({ title: z.string().optional(), channelTitle: z.string().optional() }).optional(),
});

const SearchResponseSchema = z.object({
  items: z.array(SearchItemSchema).optional(),
});

const VideoItemSchema = z.object({
  id: z.string().optional(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  statistics: z.object({ viewCount: z.string().optional() }).optional(),
  status: z.object({ embeddable: z.boolean().optional() }).optional(),
});

const VideosResponseSchema = z.object({
  items: z.array(VideoItemSchema).optional(),
});

/**
 * search.list (100 units) plus one videos.list (1 unit) for duration and
 * views. The key is a query param, as the API requires. Failures report
 * only the status and the API reason, never the URL.
 */
export class YouTubeDishVideoClient implements DishVideoSearchClient {
  private readonly timeoutMs: number;
  private readonly searchUrl: string;
  private readonly videosUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: YouTubeDishVideoConfig) {
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.searchUrl = config.searchUrl ?? 'https://www.googleapis.com/youtube/v3/search';
    this.videosUrl = config.videosUrl ?? 'https://www.googleapis.com/youtube/v3/videos';
    this.fetchFn = config.fetchFn ?? fetch;
  }

  buildSearchUrl(dishName: string): string {
    const url = new URL(this.searchUrl);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', String(DISH_VIDEO_SEARCH_COUNT));
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('relevanceLanguage', 'en');
    url.searchParams.set('q', dishVideoSearchQuery(dishName));
    url.searchParams.set('key', this.config.apiKey);
    return url.toString();
  }

  buildVideosUrl(ids: readonly string[]): string {
    const url = new URL(this.videosUrl);
    url.searchParams.set('part', 'contentDetails,statistics,status');
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('key', this.config.apiKey);
    return url.toString();
  }

  async search(dishName: string): Promise<DishVideo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const searchJson = await this.getJson(this.buildSearchUrl(dishName), controller.signal);
      const searchParsed = SearchResponseSchema.parse(searchJson);
      const hits: DishVideoHit[] = [];
      for (const item of searchParsed.items ?? []) {
        const videoId = item.id?.videoId;
        const title = item.snippet?.title?.trim();
        if (!videoId || !title) continue;
        hits.push({
          videoId,
          title,
          ...(item.snippet?.channelTitle ? { channelTitle: item.snippet.channelTitle } : {}),
        });
      }
      if (hits.length === 0) return [];
      const detailsJson = await this.getJson(
        this.buildVideosUrl(hits.map((hit) => hit.videoId)),
        controller.signal
      );
      const detailsParsed = VideosResponseSchema.parse(detailsJson);
      const details = new Map<string, DishVideoDetails>();
      for (const item of detailsParsed.items ?? []) {
        if (!item.id) continue;
        const durationSeconds = item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : null;
        if (durationSeconds === null) continue;
        const viewCount = Number(item.statistics?.viewCount ?? '0');
        details.set(item.id, {
          durationSeconds,
          viewCount: Number.isFinite(viewCount) ? viewCount : 0,
          embeddable: item.status?.embeddable === true,
        });
      }
      return selectDishVideos(dishName, hits, details);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`YouTube dish search timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchFn(url, { signal });
    if (!response.ok) {
      let reason = '';
      try {
        const body = (await response.json()) as { error?: { errors?: { reason?: string }[] } };
        reason = body.error?.errors?.[0]?.reason ?? '';
      } catch {
        // ignore unparseable error bodies
      }
      throw new Error(`YouTube search failed: ${response.status}${reason ? ` ${reason}` : ''}`);
    }
    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const CachedVideoSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channelTitle: z.string().optional(),
});

const CacheRowSchema = z.object({
  normalized_dish_name: z.string(),
  search_query: z.string(),
  videos_json: z.array(CachedVideoSchema),
  fetched_at: z.string(),
});

function videosFromRow(raw: unknown): DishVideo[] {
  const parsed = z.array(CachedVideoSchema).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.flatMap((video) => {
    if (!isYouTubeVideoId(video.videoId) || !youtubeWatchUrl(video.videoId) || !video.title.trim()) return [];
    return [
      {
        videoId: video.videoId,
        title: video.title.trim().slice(0, MAX_TITLE_LENGTH),
        ...(video.channelTitle?.trim()
          ? { channelTitle: video.channelTitle.trim().slice(0, MAX_TITLE_LENGTH) }
          : {}),
      },
    ];
  });
}

/** dish_videos table (service role only). */
export class SupabaseDishVideoCache implements DishVideoCache {
  private readonly rest: SupabaseRest;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async get(normalizedDishName: string): Promise<CachedDishVideos | null> {
    const rows = await this.rest.select<unknown>('dish_videos', {
      select: 'normalized_dish_name,search_query,videos_json,fetched_at',
      normalized_dish_name: `eq.${normalizedDishName}`,
      limit: '1',
    });
    const raw = rows[0];
    if (!raw) return null;
    const row = CacheRowSchema.parse(normalizeVideosJson(raw));
    return {
      normalizedDishName: row.normalized_dish_name,
      searchQuery: row.search_query,
      videos: videosFromRow(row.videos_json).slice(0, DISH_VIDEO_LIMIT),
      fetchedAt: new Date(row.fetched_at),
    };
  }

  async put(entry: CachedDishVideos): Promise<void> {
    await this.rest.upsert('dish_videos', [
      {
        normalized_dish_name: entry.normalizedDishName,
        search_query: entry.searchQuery,
        videos_json: entry.videos.slice(0, DISH_VIDEO_LIMIT),
        fetched_at: entry.fetchedAt.toISOString(),
      },
    ]);
  }
}

function normalizeVideosJson(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const row = raw as { videos_json?: unknown };
  if (typeof row.videos_json === 'string') {
    try {
      return { ...row, videos_json: JSON.parse(row.videos_json) as unknown };
    } catch {
      return { ...row, videos_json: [] };
    }
  }
  return raw;
}

/** Dev / test cache (lost on restart). */
export class InMemoryDishVideoCache implements DishVideoCache {
  readonly entries = new Map<string, CachedDishVideos>();

  get(normalizedDishName: string): Promise<CachedDishVideos | null> {
    return Promise.resolve(this.entries.get(normalizedDishName) ?? null);
  }

  put(entry: CachedDishVideos): Promise<void> {
    this.entries.set(entry.normalizedDishName, entry);
    return Promise.resolve();
  }
}
