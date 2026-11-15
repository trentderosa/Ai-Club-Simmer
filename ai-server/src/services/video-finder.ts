/**
 * Technique videos (PRD F4).
 *
 * For each distinct technique in a recipe, find one beginner YouTube video:
 *   1. Look the technique up in the shared cache (technique_videos), so a
 *      search is never repeated for another user (quota: ~100 searches/day).
 *   2. On a miss, run one YouTube Data API v3 search and cache the top result.
 *      "No result" is cached too, so a dead-end search isn't repeated.
 *   3. Any failure (no key, quota, network, timeout) leaves that technique
 *      without a video; the recipe still works. Failures are not cached.
 *
 * Results are keyed by the recipe's exact `techniqueName` string, so the app
 * looks a step's video up with `videos[step.techniqueName]`.
 */
import { z } from 'zod';
import type { Recipe } from '../schemas/recipe.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';

export interface TechniqueVideo {
  videoId: string;
  title?: string;
  channelTitle?: string;
}

/** techniqueName (exactly as in the recipe) -> video. Techniques with no video are absent. */
export type RecipeVideos = Record<string, TechniqueVideo>;

export interface CachedTechniqueVideo {
  techniqueKey: string;
  searchQuery: string;
  video: TechniqueVideo | null;
  fetchedAt: Date;
}

export interface TechniqueVideoCache {
  getMany(keys: string[]): Promise<Map<string, CachedTechniqueVideo>>;
  put(entry: CachedTechniqueVideo): Promise<void>;
}

export interface VideoSearchClient {
  /** Top beginner video for the query, or null when there are no results. */
  search(query: string): Promise<TechniqueVideo | null>;
}

export interface VideoFinderLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

/** Cap searches per recipe so one recipe can't burn a big share of the daily quota. */
export const MAX_VIDEO_SEARCHES_PER_RECIPE = 6;
/** Re-try a cached "no result" after this long. Found videos are kept. */
export const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache key: lowercase, trimmed, internal whitespace collapsed, max 100 chars. */
export function normalizeTechniqueKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
}

/** PRD F4 example: "how to dice an onion beginner". */
export function buildSearchQuery(techniqueKey: string): string {
  return `how to ${techniqueKey} beginner cooking`;
}

export class VideoFinder {
  constructor(
    private readonly cache: TechniqueVideoCache,
    private readonly search: VideoSearchClient,
    private readonly logger: VideoFinderLogger = console,
    private readonly now: () => Date = (): Date => new Date()
  ) {}

  async findForRecipe(recipe: Recipe): Promise<RecipeVideos> {
    // Distinct technique names, in step order, grouped by cache key.
    const namesByKey = new Map<string, string[]>();
    for (const step of recipe.steps) {
      const name = step.techniqueName?.trim();
      if (!name) continue;
      const key = normalizeTechniqueKey(name);
      if (!key) continue;
      const names = namesByKey.get(key) ?? [];
      if (!names.includes(step.techniqueName as string)) names.push(step.techniqueName as string);
      namesByKey.set(key, names);
    }
    if (namesByKey.size === 0) return {};

    const keys = [...namesByKey.keys()];
    let cached = new Map<string, CachedTechniqueVideo>();
    try {
      cached = await this.cache.getMany(keys);
    } catch (error) {
      this.logger.warn('video_cache_read_failed', { error: errorMessage(error) });
    }

    const found = new Map<string, TechniqueVideo>();
    let searches = 0;
    for (const key of keys) {
      const hit = cached.get(key);
      if (hit && (hit.video || this.now().getTime() - hit.fetchedAt.getTime() < NEGATIVE_CACHE_TTL_MS)) {
        if (hit.video) found.set(key, hit.video);
        continue;
      }
      if (searches >= MAX_VIDEO_SEARCHES_PER_RECIPE) {
        this.logger.warn('video_search_skipped_cap', { technique: key, cap: MAX_VIDEO_SEARCHES_PER_RECIPE });
        continue;
      }
      searches++;
      const query = buildSearchQuery(key);
      let video: TechniqueVideo | null;
      try {
        video = await this.search.search(query);
      } catch (error) {
        // Not cached: a transient failure shouldn't block the technique for a week.
        this.logger.warn('video_search_failed', { technique: key, error: errorMessage(error) });
        continue;
      }
      if (video) found.set(key, video);
      try {
        await this.cache.put({ techniqueKey: key, searchQuery: query, video, fetchedAt: this.now() });
      } catch (error) {
        this.logger.warn('video_cache_write_failed', { technique: key, error: errorMessage(error) });
      }
    }

    const result: RecipeVideos = {};
    for (const [key, names] of namesByKey) {
      const video = found.get(key);
      if (!video) continue;
      for (const name of names) result[name] = video;
    }
    return result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// YouTube Data API v3 search
// ---------------------------------------------------------------------------

export interface YouTubeSearchConfig {
  apiKey: string;
  timeoutMs?: number;
  baseUrl?: string;
}

const YouTubeSearchResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/).optional() }),
        snippet: z
          .object({ title: z.string().optional(), channelTitle: z.string().optional() })
          .optional(),
      })
    )
    .optional(),
});

/**
 * One search.list call (100 quota units). The API key goes in the query
 * string, as the API requires, so errors report only the status and the
 * API's error reason, never the URL.
 */
export class YouTubeSearchClient implements VideoSearchClient {
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly config: YouTubeSearchConfig) {
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.baseUrl = config.baseUrl ?? 'https://www.googleapis.com/youtube/v3/search';
  }

  buildUrl(query: string): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('relevanceLanguage', 'en');
    url.searchParams.set('q', query);
    url.searchParams.set('key', this.config.apiKey);
    return url.toString();
  }

  async search(query: string): Promise<TechniqueVideo | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.buildUrl(query), { signal: controller.signal });
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
      const parsed = YouTubeSearchResponseSchema.parse(await response.json());
      const item = parsed.items?.find((i) => i.id.videoId);
      if (!item?.id.videoId) return null;
      return {
        videoId: item.id.videoId,
        ...(item.snippet?.title ? { title: item.snippet.title } : {}),
        ...(item.snippet?.channelTitle ? { channelTitle: item.snippet.channelTitle } : {}),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`YouTube search timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const CacheRowSchema = z.object({
  technique_key: z.string(),
  search_query: z.string(),
  video_id: z.string().nullable(),
  video_title: z.string().nullable(),
  channel_title: z.string().nullable(),
  fetched_at: z.string(),
});

/** technique_videos table (service role only). */
export class SupabaseTechniqueVideoCache implements TechniqueVideoCache {
  private readonly rest: SupabaseRest;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async getMany(keys: string[]): Promise<Map<string, CachedTechniqueVideo>> {
    const result = new Map<string, CachedTechniqueVideo>();
    if (keys.length === 0) return result;
    // PostgREST in.(...) list; quote each key and escape quotes/backslashes.
    const list = keys.map((k) => `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
    const rows = await this.rest.select<unknown>('technique_videos', {
      select: 'technique_key,search_query,video_id,video_title,channel_title,fetched_at',
      technique_key: `in.(${list})`,
    });
    for (const raw of rows) {
      const row = CacheRowSchema.parse(raw);
      result.set(row.technique_key, {
        techniqueKey: row.technique_key,
        searchQuery: row.search_query,
        video: row.video_id
          ? {
              videoId: row.video_id,
              ...(row.video_title ? { title: row.video_title } : {}),
              ...(row.channel_title ? { channelTitle: row.channel_title } : {}),
            }
          : null,
        fetchedAt: new Date(row.fetched_at),
      });
    }
    return result;
  }

  async put(entry: CachedTechniqueVideo): Promise<void> {
    await this.rest.upsert('technique_videos', [
      {
        technique_key: entry.techniqueKey,
        search_query: entry.searchQuery,
        video_id: entry.video?.videoId ?? null,
        video_title: entry.video?.title ?? null,
        channel_title: entry.video?.channelTitle ?? null,
        fetched_at: entry.fetchedAt.toISOString(),
      },
    ]);
  }
}

/** Dev / test cache (lost on restart). */
export class InMemoryTechniqueVideoCache implements TechniqueVideoCache {
  readonly entries = new Map<string, CachedTechniqueVideo>();

  getMany(keys: string[]): Promise<Map<string, CachedTechniqueVideo>> {
    const result = new Map<string, CachedTechniqueVideo>();
    for (const key of keys) {
      const hit = this.entries.get(key);
      if (hit) result.set(key, hit);
    }
    return Promise.resolve(result);
  }

  put(entry: CachedTechniqueVideo): Promise<void> {
    this.entries.set(entry.techniqueKey, entry);
    return Promise.resolve();
  }
}
