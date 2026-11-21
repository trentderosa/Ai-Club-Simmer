/**
 * Technique videos (PRD F4).
 *
 * For each distinct technique in a recipe, find one beginner YouTube video:
 *   1. Look the technique up in the shared cache (technique_videos), so a
 *      search is never repeated for another user (quota: ~100 searches/day).
 *   2. On a miss, run one YouTube Data API v3 search (up to 5 results) and one
 *      videos.list for duration. Keep the first hit whose title shares the
 *      technique's meaningful words, is not a very short non-demo, and is
 *      not a different dish. "No result" (including a fully rejected search)
 *      is cached too, so a dead-end search isn't repeated. The recipe still
 *      returns with no video for that technique.
 *   3. Any failure (no key, quota, network, timeout) leaves that technique
 *      without a video; the recipe still works. Failures are not cached.
 *   4. New searches run concurrently under one time budget per recipe
 *      (VIDEO_LOOKUP_BUDGET_MS), so a YouTube outage can't stall the response.
 *
 * findForRecipe reports `complete: false` when any technique wasn't settled
 * (search failed, timed out, ran past the budget, or was skipped by the cap).
 * Callers must not store an incomplete result as final, so the lookup is
 * retried on a later visit. A genuine "no result" is complete (and cached).
 *
 * Results are keyed by the recipe's exact `techniqueName` string, so the app
 * looks a step's video up with `videos[step.techniqueName]`.
 */
import { z } from 'zod';
import { isYouTubeVideoId } from '../cook-anything/youtube-url.js';
import type { Recipe } from '../schemas/recipe.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';
import {
  hasConflictingDishWords,
  isVeryShortNonDemo,
  parseIsoDuration,
  techniqueSubjectFromQuery,
  titleSharesMeaningfulWords,
} from './video-match.js';

export interface TechniqueVideo {
  videoId: string;
  title?: string;
  channelTitle?: string;
}

/** techniqueName (exactly as in the recipe) -> video. Techniques with no video are absent. */
export type RecipeVideos = Record<string, TechniqueVideo>;

export interface VideoLookupResult {
  videos: RecipeVideos;
  /**
   * True when every technique got a definite answer (a video or a genuine
   * "no result"). False when any search failed, timed out, ran past the time
   * budget, or was skipped by the per-recipe cap: don't persist it as final.
   */
  complete: boolean;
}

export interface VideoFinderOptions {
  /** Wall-clock budget for all new searches of one recipe, in ms. */
  budgetMs?: number;
}

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
  /** First acceptable beginner video, or null when nothing matches. */
  search(query: string): Promise<TechniqueVideo | null>;
}

export interface VideoFinderLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

/** Cap searches per recipe so one recipe can't burn a big share of the daily quota. */
export const MAX_VIDEO_SEARCHES_PER_RECIPE = 6;
/** Hits inspected per technique. search.list costs the same for 1 or 5. */
export const TECHNIQUE_SEARCH_COUNT = 5;
/** Re-try a cached "no result" after this long. Found videos are kept. */
export const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Default VIDEO_LOOKUP_BUDGET_MS: all of a recipe's searches together. */
export const DEFAULT_VIDEO_LOOKUP_BUDGET_MS = 8000;

/** Cache key: lowercase, trimmed, internal whitespace collapsed, max 100 chars. */
export function normalizeTechniqueKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
}

/** PRD F4 example: "how to dice an onion beginner". */
export function buildSearchQuery(techniqueKey: string): string {
  return `how to ${techniqueKey} beginner cooking`;
}

export class VideoFinder {
  private readonly budgetMs: number;

  constructor(
    private readonly cache: TechniqueVideoCache,
    private readonly search: VideoSearchClient,
    private readonly logger: VideoFinderLogger = console,
    private readonly now: () => Date = (): Date => new Date(),
    options: VideoFinderOptions = {}
  ) {
    this.budgetMs = options.budgetMs ?? DEFAULT_VIDEO_LOOKUP_BUDGET_MS;
  }

  async findForRecipe(recipe: Recipe): Promise<VideoLookupResult> {
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
    if (namesByKey.size === 0) return { videos: {}, complete: true };

    const keys = [...namesByKey.keys()];
    let cached = new Map<string, CachedTechniqueVideo>();
    try {
      cached = await this.cache.getMany(keys);
    } catch (error) {
      this.logger.warn('video_cache_read_failed', { error: errorMessage(error) });
    }

    const found = new Map<string, TechniqueVideo>();
    const toSearch: string[] = [];
    let complete = true;
    for (const key of keys) {
      const hit = cached.get(key);
      if (hit && (hit.video || this.now().getTime() - hit.fetchedAt.getTime() < NEGATIVE_CACHE_TTL_MS)) {
        if (hit.video) found.set(key, hit.video);
        continue;
      }
      if (toSearch.length >= MAX_VIDEO_SEARCHES_PER_RECIPE) {
        // Left for a later visit, when the searched ones are cached.
        this.logger.warn('video_search_skipped_cap', { technique: key, cap: MAX_VIDEO_SEARCHES_PER_RECIPE });
        complete = false;
        continue;
      }
      toSearch.push(key);
    }

    if (toSearch.length > 0) {
      const settled = new Set<string>();
      let budgetExpired = false;
      // Each task catches its own errors, so none of them can reject. A task
      // that outlives the budget still caches its result for the next visit.
      const tasks = toSearch.map(async (key) => {
        const query = buildSearchQuery(key);
        let video: TechniqueVideo | null;
        try {
          video = await this.search.search(query);
        } catch (error) {
          // Not cached: a transient failure shouldn't block the technique for a week.
          this.logger.warn('video_search_failed', { technique: key, error: errorMessage(error) });
          return;
        }
        if (!budgetExpired) {
          settled.add(key);
          if (video) found.set(key, video);
        }
        try {
          await this.cache.put({ techniqueKey: key, searchQuery: query, video, fetchedAt: this.now() });
        } catch (error) {
          this.logger.warn('video_cache_write_failed', { technique: key, error: errorMessage(error) });
        }
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          budgetExpired = true;
          resolve();
        }, this.budgetMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.allSettled(tasks), budget]);
      } finally {
        clearTimeout(timer);
      }

      const unsettled = toSearch.filter((key) => !settled.has(key));
      if (unsettled.length > 0) {
        complete = false;
        if (budgetExpired) {
          this.logger.warn('video_lookup_budget_exceeded', { budget_ms: this.budgetMs, unsettled: unsettled.length });
        }
      }
    }

    const videos: RecipeVideos = {};
    for (const [key, names] of namesByKey) {
      const video = found.get(key);
      if (!video) continue;
      for (const name of names) videos[name] = video;
    }
    return { videos, complete };
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
  videosUrl?: string;
}

const YouTubeSearchResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().optional() }).optional(),
        snippet: z
          .object({ title: z.string().optional(), channelTitle: z.string().optional() })
          .optional(),
      })
    )
    .optional(),
});

const YouTubeVideosResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        contentDetails: z.object({ duration: z.string().optional() }).optional(),
        status: z.object({ embeddable: z.boolean().optional() }).optional(),
      })
    )
    .optional(),
});

interface TechniqueHit {
  videoId: string;
  title: string;
  channelTitle?: string;
}

interface TechniqueHitDetails {
  durationSeconds: number;
  embeddable: boolean;
}

/**
 * One search.list call (100 quota units) plus one videos.list (1 unit) when
 * a title is worth checking. The API key goes in the query string, as the
 * API requires, so errors report only the status and the API's error reason,
 * never the URL. A rejected hit is skipped; if none qualify, the result is
 * null (a genuine "no result", not a failed search).
 */
export class YouTubeSearchClient implements VideoSearchClient {
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly videosUrl: string;

  constructor(private readonly config: YouTubeSearchConfig) {
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.baseUrl = config.baseUrl ?? 'https://www.googleapis.com/youtube/v3/search';
    this.videosUrl = config.videosUrl ?? videosEndpoint(this.baseUrl);
  }

  buildUrl(query: string): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', String(TECHNIQUE_SEARCH_COUNT));
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('relevanceLanguage', 'en');
    url.searchParams.set('q', query);
    url.searchParams.set('key', this.config.apiKey);
    return url.toString();
  }

  buildVideosUrl(ids: readonly string[]): string {
    const url = new URL(this.videosUrl);
    url.searchParams.set('part', 'contentDetails,status');
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('key', this.config.apiKey);
    return url.toString();
  }

  async search(query: string): Promise<TechniqueVideo | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const searchJson = await this.getJson(this.buildUrl(query), controller.signal);
      const techniqueName = techniqueSubjectFromQuery(query);
      const hits = techniqueHits(YouTubeSearchResponseSchema.parse(searchJson), techniqueName);
      if (hits.length === 0) return null;
      const detailsJson = await this.getJson(
        this.buildVideosUrl(hits.map((hit) => hit.videoId)),
        controller.signal
      );
      const details = techniqueDetails(YouTubeVideosResponseSchema.parse(detailsJson));
      return pickTechniqueVideo(techniqueName, hits, details);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`YouTube search timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(url, { signal });
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

function videosEndpoint(searchUrl: string): string {
  if (searchUrl.endsWith('/search')) return `${searchUrl.slice(0, -'/search'.length)}/videos`;
  return 'https://www.googleapis.com/youtube/v3/videos';
}

function techniqueHits(parsed: z.infer<typeof YouTubeSearchResponseSchema>, techniqueName: string): TechniqueHit[] {
  const hits: TechniqueHit[] = [];
  for (const item of parsed.items ?? []) {
    const videoId = item.id?.videoId;
    const title = item.snippet?.title?.trim();
    if (!videoId || !title || !isYouTubeVideoId(videoId)) continue;
    if (!titleSharesMeaningfulWords(title, techniqueName, true)) continue;
    hits.push({
      videoId,
      title,
      ...(item.snippet?.channelTitle ? { channelTitle: item.snippet.channelTitle } : {}),
    });
  }
  return hits;
}

function techniqueDetails(parsed: z.infer<typeof YouTubeVideosResponseSchema>): Map<string, TechniqueHitDetails> {
  const details = new Map<string, TechniqueHitDetails>();
  for (const item of parsed.items ?? []) {
    if (!item.id) continue;
    const durationSeconds = item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : null;
    if (durationSeconds === null || durationSeconds <= 0) continue;
    details.set(item.id, {
      durationSeconds,
      embeddable: item.status?.embeddable === true,
    });
  }
  return details;
}

function pickTechniqueVideo(
  techniqueName: string,
  hits: readonly TechniqueHit[],
  details: ReadonlyMap<string, TechniqueHitDetails>
): TechniqueVideo | null {
  for (const hit of hits) {
    const detail = details.get(hit.videoId);
    if (!detail?.embeddable) continue;
    if (isVeryShortNonDemo(hit.title, detail.durationSeconds, techniqueName)) continue;
    if (hasConflictingDishWords(hit.title, techniqueName, true)) continue;
    return {
      videoId: hit.videoId,
      title: hit.title,
      ...(hit.channelTitle ? { channelTitle: hit.channelTitle } : {}),
    };
  }
  return null;
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
