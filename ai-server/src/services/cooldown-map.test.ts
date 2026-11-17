import { describe, expect, it } from 'vitest';
import { rememberUntil } from './cooldown-map.js';

describe('rememberUntil', () => {
  it('drops expired keys on write', () => {
    const map = new Map<string, number>([
      ['stale', 10],
      ['live', 50],
    ]);
    rememberUntil(map, 'fresh', 80, 20, 10);
    expect([...map.keys()].sort()).toEqual(['fresh', 'live']);
    expect(map.get('fresh')).toBe(80);
  });

  it('evicts the earliest expiry when the cap is exceeded', () => {
    const map = new Map<string, number>([
      ['a', 30],
      ['b', 40],
    ]);
    rememberUntil(map, 'c', 50, 0, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe(40);
    expect(map.get('c')).toBe(50);
  });
});
