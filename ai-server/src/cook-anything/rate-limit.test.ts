import { describe, expect, it } from 'vitest';
import { GenerationRateLimiter } from './rate-limit.js';

describe('GenerationRateLimiter', () => {
  it('allows up to max uncached generations per user per window', async () => {
    const limiter = new GenerationRateLimiter(60_000, 2);
    const t = 1_000_000;
    expect(await limiter.allow('user-a', t)).toBe(true);
    expect(await limiter.allow('user-a', t + 10)).toBe(true);
    expect(await limiter.allow('user-a', t + 20)).toBe(false);
    expect(await limiter.allow('user-b', t + 20)).toBe(true);
  });

  it('drops a hit exactly one window old and allows the next', async () => {
    const limiter = new GenerationRateLimiter(100, 1);
    expect(await limiter.allow('user-a', 0)).toBe(true);
    expect(await limiter.allow('user-a', 50)).toBe(false);
    expect(await limiter.allow('user-a', 100)).toBe(true);
  });

  it('does not share hits with a new instance', async () => {
    const first = new GenerationRateLimiter(100, 1);
    const restarted = new GenerationRateLimiter(100, 1);
    expect(await first.allow('user-a', 0)).toBe(true);
    expect(await restarted.allow('user-a', 50)).toBe(true);
  });
});
