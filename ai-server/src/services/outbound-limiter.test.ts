import { describe, expect, it } from 'vitest';
import { OutboundLimiter } from './outbound-limiter.js';

describe('OutboundLimiter', () => {
  it('allows up to the cap and blocks the next request', () => {
    const t = 1000;
    const limiter = new OutboundLimiter(3, 60_000, () => t);
    expect([limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([true, true, true]);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('allows requests again once the window rolls over', () => {
    let t = 0;
    const limiter = new OutboundLimiter(2, 1000, () => t);
    expect(limiter.tryAcquire()).toBe(true);
    t = 500;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    t = 1000; // first stamp (0) has aged out, second (500) has not
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    t = 1500;
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('does not count blocked attempts against the window', () => {
    let t = 0;
    const limiter = new OutboundLimiter(1, 1000, () => t);
    expect(limiter.tryAcquire()).toBe(true);
    t = 900;
    expect(limiter.tryAcquire()).toBe(false);
    t = 1000;
    expect(limiter.tryAcquire()).toBe(true);
  });
});
