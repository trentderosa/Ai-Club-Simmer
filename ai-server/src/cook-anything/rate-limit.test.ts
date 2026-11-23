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

  it('refund restores one unit of capacity and only for that user', async () => {
    const limiter = new GenerationRateLimiter(60_000, 2);
    const t = 1_000_000;
    expect(await limiter.allow('user-a', t)).toBe(true);
    expect(await limiter.allow('user-a', t + 10)).toBe(true);
    expect(await limiter.allow('user-b', t + 10)).toBe(true);
    expect(await limiter.allow('user-a', t + 20)).toBe(false);
    expect(await limiter.refund('user-a', t + 20)).toBe(true);
    expect(await limiter.allow('user-a', t + 30)).toBe(true);
    expect(await limiter.allow('user-a', t + 40)).toBe(false);
    // user-b still has its one hit.
    expect(await limiter.allow('user-b', t + 40)).toBe(true);
    expect(await limiter.allow('user-b', t + 50)).toBe(false);
  });

  it('refund removes at most one hit and returns false when there is none', async () => {
    const limiter = new GenerationRateLimiter(100, 2);
    expect(await limiter.refund('user-a', 0)).toBe(false);
    expect(await limiter.allow('user-a', 0)).toBe(true);
    expect(await limiter.refund('user-a', 10)).toBe(true);
    expect(await limiter.refund('user-a', 10)).toBe(false);
    // A hit already outside the window is not refunded.
    expect(await limiter.allow('user-a', 20)).toBe(true);
    expect(await limiter.refund('user-a', 120)).toBe(false);
  });
});
