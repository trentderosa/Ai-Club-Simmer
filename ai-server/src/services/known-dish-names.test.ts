import { describe, expect, it } from 'vitest';
import { collectKnownDishNames } from './known-dish-names.js';

describe('collectKnownDishNames', () => {
  it('normalizes path and generated names and drops blanks', () => {
    expect(
      collectKnownDishNames(['  Pho  ', 'Chicken Parmesan', ''], ['PAD THAI', '   '])
    ).toEqual(new Set(['pho', 'chicken parmesan', 'pad thai']));
  });
});
