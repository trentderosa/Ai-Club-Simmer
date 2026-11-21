/**
 * Per-user limiter for uncached cook-anything generations.
 * Cached reuse does not call this.
 *
 * GenerationRateLimiter is the dev fallback when Supabase is not configured.
 * It lives in this process only. Production uses SupabaseGenerationRateLimiter,
 * which stores hits in cook_anything_generation_hits.
 */
export interface CookAnythingGenerationLimiter {
  /**
   * @param now epoch milliseconds. The in-memory limiter uses it as the clock.
   * The database limiter forwards it when provided and otherwise uses the database clock.
   */
  allow(userId: string, now?: number): Promise<boolean>;
  /**
   * Gives back the generation allow() just charged, for a request that ended
   * busy. Removes one recent hit for the user. Resolves true when a hit was
   * removed and false when there was nothing to remove or the store does not
   * support refunds yet. Callers treat a rejection as best effort.
   * @param now epoch milliseconds, same meaning as in allow().
   */
  refund(userId: string, now?: number): Promise<boolean>;
}

export class GenerationRateLimiter implements CookAnythingGenerationLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  allow(userId: string, now = Date.now()): Promise<boolean> {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.max) {
      this.hits.set(userId, times);
      return Promise.resolve(false);
    }
    times.push(now);
    this.hits.set(userId, times);
    return Promise.resolve(true);
  }

  refund(userId: string, now = Date.now()): Promise<boolean> {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    const removed = times.pop() !== undefined;
    this.hits.set(userId, times);
    return Promise.resolve(removed);
  }
}
