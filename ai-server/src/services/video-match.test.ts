import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './video-finder.js';
import {
  hasConflictingDishWords,
  isTechniqueDemoTitle,
  isVeryShortNonDemo,
  techniqueSubjectFromQuery,
  titleSharesMeaningfulWords,
} from './video-match.js';

describe('titleSharesMeaningfulWords', () => {
  it('requires whole words, not a piece of a longer word', () => {
    expect(titleSharesMeaningfulWords('How to photograph food', 'pho')).toBe(false);
    expect(titleSharesMeaningfulWords('How to boil water', 'oil')).toBe(false);
    expect(titleSharesMeaningfulWords('Eggplant parmesan recipe', 'egg')).toBe(false);
    expect(titleSharesMeaningfulWords('Hamburger helper', 'ham')).toBe(false);
    expect(titleSharesMeaningfulWords('What is the price of rice', 'fried rice')).toBe(false);
    expect(titleSharesMeaningfulWords('What is the price', 'rice')).toBe(false);
    expect(titleSharesMeaningfulWords('Authentic pho recipe', 'pho')).toBe(true);
    expect(titleSharesMeaningfulWords('How to dice an onion', 'dice an onion')).toBe(true);
    expect(titleSharesMeaningfulWords('Diced onions', 'dice an onion')).toBe(false);
    expect(titleSharesMeaningfulWords('Diced onions', 'dice an onion', true)).toBe(true);
    expect(titleSharesMeaningfulWords('Chopped onions', 'chop', true)).toBe(true);
    expect(titleSharesMeaningfulWords('Pan fried dumplings', 'pan fry', true)).toBe(true);
    expect(titleSharesMeaningfulWords('How to sauté onions', 'saute onions', true)).toBe(true);
  });
});

describe('hasConflictingDishWords', () => {
  it('rejects a different dish and keeps a closer variant', () => {
    expect(hasConflictingDishWords('Scrambled eggs fried rice recipe', 'scrambled eggs')).toBe(true);
    expect(hasConflictingDishWords('Fried chicken and white rice', 'fried rice')).toBe(true);
    expect(hasConflictingDishWords('Chicken noodle soup recipe', 'chicken soup')).toBe(true);
    expect(hasConflictingDishWords('French toast recipe', 'toast')).toBe(true);
    expect(hasConflictingDishWords('Egg fried rice recipe', 'fried rice')).toBe(false);
    expect(hasConflictingDishWords('Tomato basil soup', 'tomato soup')).toBe(false);
    expect(hasConflictingDishWords('Chicken pho recipe', 'pho')).toBe(false);
    expect(hasConflictingDishWords('French onion soup', 'onion soup')).toBe(false);
  });
});

describe('short technique clips', () => {
  it('reads the technique out of the search query', () => {
    expect(techniqueSubjectFromQuery('how to dice an onion beginner cooking')).toBe('dice an onion');
  });

  it('reads back the technique from the query the finder really builds', () => {
    // If buildSearchQuery's template changes, this fails instead of every
    // title quietly needing "beginner" and "cooking".
    for (const key of ['dice onion', 'pan toast', 'sear chicken', 'claw grip']) {
      expect(techniqueSubjectFromQuery(buildSearchQuery(key))).toBe(key);
    }
  });

  it('drops a very short clip unless the title is a technique demo', () => {
    expect(isTechniqueDemoTitle('How to dice an onion', 'dice an onion')).toBe(true);
    expect(isTechniqueDemoTitle('Dicing onions in 15 seconds', 'dice an onion')).toBe(false);
    expect(isVeryShortNonDemo('Dicing onions in 15 seconds', 15, 'dice an onion')).toBe(true);
    expect(isVeryShortNonDemo('How to dice an onion', 45, 'dice an onion')).toBe(false);
    expect(isVeryShortNonDemo('How to dice an onion #shorts', 45, 'dice an onion')).toBe(false);
    expect(isVeryShortNonDemo('Dicing onions shorts', 180, 'dice an onion')).toBe(true);
    expect(isVeryShortNonDemo('How to dice an onion', 180, 'dice an onion')).toBe(false);
  });
});
