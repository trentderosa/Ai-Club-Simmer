import { describe, expect, it } from 'vitest';
import { GenerationRateLimiter } from './rate-limit.js';

describe('GenerationRateLimiter', () => {
  it('allows up to max uncached generations per user per window', () => {
    const limiter = new GenerationRateLimiter(60_000, 2);
    const t = 1_000_000;
    expect(limiter.allow('user-a', t)).toBe(true);
    expect(limiter.allow('user-a', t + 10)).toBe(true);
    expect(limiter.allow('user-a', t + 20)).toBe(false);
    expect(limiter.allow('user-b', t + 20)).toBe(true);
  });

  it('resets after the window', () => {
    const limiter = new GenerationRateLimiter(100, 1);
    expect(limiter.allow('user-a', 0)).toBe(true);
    expect(limiter.allow('user-a', 50)).toBe(false);
    expect(limiter.allow('user-a', 101)).toBe(true);
  });
});
