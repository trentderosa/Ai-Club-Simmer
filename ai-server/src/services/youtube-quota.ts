/**
 * Daily YouTube quota pause.
 *
 * A quotaExceeded or dailyLimitExceeded error pauses every technique and dish
 * search until midnight Pacific. The pause used to live on the finder object,
 * so a restart searched again. With Supabase configured, claim_youtube_search
 * records each search that is about to run, and record_youtube_quota_cooldown
 * stores the pause. A database failure skips the search: the recipe still
 * returns, and YouTube is not called.
 */
import { SupabaseRest, SupabaseRestError, type SupabaseRestConfig } from './supabase-rest.js';

/** Matches MAX_VIDEO_SEARCHES_PER_RECIPE and claim_youtube_search's bound. */
export const YOUTUBE_QUOTA_MAX_SEARCHES = 6;

export interface YouTubeQuotaLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export interface YouTubeQuotaGate {
  /**
   * Record `count` searches unless a daily pause is active.
   * Returns the pause end when YouTube must not be called.
   * Returns null when the searches were recorded and may run.
   * Throws when the store cannot be read or written.
   */
  claimSearches(count: number, now: Date): Promise<Date | null>;
  /**
   * Pause every search until `until`. The in-process pause is kept even when
   * the write throws, so this process does not call YouTube again.
   */
  recordCooldown(until: Date, now: Date): Promise<Date>;
}

export interface YouTubeSearchPermission {
  allowed: boolean;
}

/** YouTube Data API quota resets at midnight Pacific Time. */
export function youtubeQuotaResetAt(now: Date): Date {
  const dateInPacific = (instant: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  const today = dateInPacific(now);
  let lo = now.getTime();
  let hi = lo + 36 * 60 * 60 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateInPacific(new Date(mid)) === today) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

export function isYouTubeQuotaError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('quotaexceeded') || message.includes('dailylimitexceeded');
}

/**
 * Ask the gate before calling YouTube. A missing gate means the in-process
 * pause (dev, no Supabase) is the caller's job. A thrown read skips the search.
 */
export async function allowYouTubeSearches(
  quota: YouTubeQuotaGate | undefined,
  count: number,
  now: Date,
  logger: YouTubeQuotaLogger
): Promise<YouTubeSearchPermission> {
  if (!quota) return { allowed: true };
  try {
    const blocked = await quota.claimSearches(count, now);
    return { allowed: blocked === null };
  } catch (error) {
    logger.warn('youtube_quota_check_failed', { error: errorMessage(error) });
    return { allowed: false };
  }
}

/**
 * Remember a quota failure until the next Pacific midnight. A failed write is
 * logged and the computed instant is still returned so this process pauses.
 */
export async function noteYouTubeQuotaExceeded(
  quota: YouTubeQuotaGate | undefined,
  now: Date,
  logger: YouTubeQuotaLogger
): Promise<Date> {
  const until = youtubeQuotaResetAt(now);
  if (!quota) return until;
  try {
    return await quota.recordCooldown(until, now);
  } catch (error) {
    logger.warn('youtube_quota_record_failed', { error: errorMessage(error) });
    return until;
  }
}

function assertSearchCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > YOUTUBE_QUOTA_MAX_SEARCHES) {
    throw new Error('claim_youtube_search count out of range');
  }
}

/** Process-local stand-in used in dev and in tests. A new finder shares this object. */
export class InMemoryYouTubeQuotaGate implements YouTubeQuotaGate {
  private cooldownUntilMs = 0;
  readonly recordedSearches: Date[] = [];

  claimSearches(count: number, now: Date): Promise<Date | null> {
    try {
      assertSearchCount(count);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (now.getTime() < this.cooldownUntilMs) return Promise.resolve(new Date(this.cooldownUntilMs));
    for (let i = 0; i < count; i += 1) this.recordedSearches.push(now);
    return Promise.resolve(null);
  }

  recordCooldown(until: Date, now: Date): Promise<Date> {
    if (until.getTime() <= now.getTime()) {
      return Promise.reject(new Error('record_youtube_quota_cooldown pause out of range'));
    }
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, until.getTime());
    return Promise.resolve(new Date(this.cooldownUntilMs));
  }
}

/**
 * youtube_search_quota via PostgREST. A failed cooldown write stays in memory
 * on this object and is retried on the next claim, which still does not call
 * YouTube.
 */
export class SupabaseYouTubeQuotaGate implements YouTubeQuotaGate {
  private readonly rest: SupabaseRest;
  private localUntilMs = 0;
  private unpersistedUntil: Date | null = null;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async claimSearches(count: number, now: Date): Promise<Date | null> {
    assertSearchCount(count);
    if (this.unpersistedUntil && now.getTime() >= this.unpersistedUntil.getTime()) {
      this.unpersistedUntil = null;
    }
    if (now.getTime() < this.localUntilMs) {
      await this.retryUnpersisted(now);
      return new Date(this.localUntilMs);
    }

    const result = await this.rest.rpc<unknown>('claim_youtube_search', {
      p_count: count,
      p_now: now.toISOString(),
    });
    const blocked = parseOptionalTimestamp(result, 'claim_youtube_search');
    if (blocked) {
      this.localUntilMs = Math.max(this.localUntilMs, blocked.getTime());
      return blocked;
    }
    return null;
  }

  async recordCooldown(until: Date, now: Date): Promise<Date> {
    if (until.getTime() <= now.getTime()) {
      throw new SupabaseRestError('record_youtube_quota_cooldown pause out of range');
    }
    const alreadySaved = this.localUntilMs >= until.getTime() && this.unpersistedUntil === null;
    this.localUntilMs = Math.max(this.localUntilMs, until.getTime());
    if (alreadySaved) return new Date(this.localUntilMs);
    try {
      const saved = await this.writeCooldown(until, now);
      this.unpersistedUntil = null;
      this.localUntilMs = Math.max(this.localUntilMs, saved.getTime());
      return new Date(this.localUntilMs);
    } catch (error) {
      this.unpersistedUntil = new Date(this.localUntilMs);
      throw error;
    }
  }

  private async retryUnpersisted(now: Date): Promise<void> {
    if (!this.unpersistedUntil) return;
    try {
      const saved = await this.writeCooldown(this.unpersistedUntil, now);
      this.unpersistedUntil = null;
      this.localUntilMs = Math.max(this.localUntilMs, saved.getTime());
    } catch {
      // The pause still holds in this process. The next claim tries again.
    }
  }

  private async writeCooldown(until: Date, now: Date): Promise<Date> {
    const result = await this.rest.rpc<unknown>('record_youtube_quota_cooldown', {
      p_until: until.toISOString(),
      p_now: now.toISOString(),
    });
    const saved = parseOptionalTimestamp(result, 'record_youtube_quota_cooldown');
    if (!saved) {
      throw new SupabaseRestError('record_youtube_quota_cooldown returned an empty pause');
    }
    return saved;
  }
}

function parseOptionalTimestamp(result: unknown, fn: string): Date | null {
  if (result === null) return null;
  if (typeof result !== 'string') {
    throw new SupabaseRestError(`${fn} returned an unexpected value`);
  }
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime())) {
    throw new SupabaseRestError(`${fn} returned a bad timestamp`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
