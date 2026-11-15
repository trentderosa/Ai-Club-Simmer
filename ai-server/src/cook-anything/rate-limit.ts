/**
 * In-memory per-user limiter for uncached cook-anything generations.
 * Cached reuse does not call this.
 */
export class GenerationRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  allow(userId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.max) {
      this.hits.set(userId, times);
      return false;
    }
    times.push(now);
    this.hits.set(userId, times);
    return true;
  }
}
