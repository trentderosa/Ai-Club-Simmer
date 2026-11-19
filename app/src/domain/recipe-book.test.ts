import type { PlanSlot, RecipeBookEntry } from '../api';
import {
  EMPTY_BOOK_COPY,
  bookEntryKey,
  bookEntryRoute,
  bookEntryTarget,
  filterBookEntries,
  formatAddedOn,
  formatBookLabel,
  formatCookDate,
  formatRating,
  recipeBookHeadline,
  sortBookEntries,
  upcomingDishes,
} from './recipe-book';

const entry = (over: Partial<RecipeBookEntry> & Pick<RecipeBookEntry, 'slot_id' | 'slot_order' | 'recipe_title'>): RecipeBookEntry => ({
  dish_name: over.recipe_title,
  user_recipe_id: '00000000-0000-4000-8000-000000000001',
  label: 'completed',
  added_at: null,
  times_cooked: 1,
  kind: 'path',
  generated_recipe_id: null,
  last_cooked_at: null,
  last_difficulty_rating: null,
  ...over,
});

const GEN_ID = '10000000-0000-4000-8000-000000000001';
const cookAnything = (over: Partial<RecipeBookEntry> = {}): RecipeBookEntry =>
  entry({
    slot_id: null,
    slot_order: null,
    recipe_title: 'Weeknight Pad Thai',
    dish_name: 'pad thai',
    user_recipe_id: null,
    kind: 'cook_anything',
    generated_recipe_id: GEN_ID,
    ...over,
  });

describe('recipe book copy', () => {
  it('names 1–10 dishes in words, then falls back to a number', () => {
    expect(recipeBookHeadline(0)).toBe('Nothing in your book yet.');
    expect(recipeBookHeadline(1)).toBe('One dish you can cook.');
    expect(recipeBookHeadline(3)).toBe('Three dishes you can cook.');
    expect(recipeBookHeadline(10)).toBe('Ten dishes you can cook.');
    expect(recipeBookHeadline(11)).toBe('11 dishes you can cook.');
  });

  it('adds a cook count only on repeats, and uses Mastered for slot 10', () => {
    expect(formatBookLabel('completed', 1)).toBe('Completed');
    expect(formatBookLabel('completed', 2)).toBe('Completed · cooked 2×');
    expect(formatBookLabel('mastered', 1)).toBe('Mastered');
    expect(formatBookLabel('mastered', 3)).toBe('Mastered · cooked 3×');
  });

  it('formats added_at in UTC so a noon-Z timestamp stays on that day', () => {
    expect(formatAddedOn('2026-11-12T12:00:00.000Z')).toBe('Added Nov 12');
    expect(formatAddedOn(null)).toBeNull();
    expect(formatAddedOn('not-a-date')).toBeNull();
  });

  it('keeps the exact empty-book sentence from CLIENT_API.md', () => {
    expect(EMPTY_BOOK_COPY).toBe('Cook a recipe and finish the check-in to add it to your recipe book.');
  });
});

describe('recipe book list helpers', () => {
  const book = [
    entry({ slot_id: 1, slot_order: 1, recipe_title: 'Crunchy Knife Basics Salad', dish_name: 'Knife Basics Salad', added_at: '2026-11-08T12:00:00.000Z' }),
    entry({ slot_id: 2, slot_order: 2, recipe_title: 'Soft Scrambled Eggs', dish_name: 'Scrambled Eggs', added_at: '2026-11-10T12:00:00.000Z', times_cooked: 2 }),
    entry({ slot_id: 3, slot_order: 3, recipe_title: 'Ribbon Pasta with Garlic and Greens', dish_name: 'Pasta with Sauce', added_at: '2026-11-12T12:00:00.000Z' }),
  ];

  it('sorts newest first', () => {
    expect(sortBookEntries(book).map((e) => e.slot_id)).toEqual([3, 2, 1]);
  });

  it('filters by title, dish name or technique', () => {
    const tech = { 2: 'Heat control', 3: 'Boiling and timing' };
    expect(filterBookEntries(book, '  pasta ', tech).map((e) => e.slot_id)).toEqual([3]);
    expect(filterBookEntries(book, 'heat', tech).map((e) => e.slot_id)).toEqual([2]);
    expect(filterBookEntries(book, '', tech)).toHaveLength(3);
  });

  it('lists path slots that are not in the book yet', () => {
    const plan = [
      { slot_id: 3, slot_order: 3, status: 'done' },
      { slot_id: 4, slot_order: 4, status: 'current' },
      { slot_id: 5, slot_order: 5, status: 'locked' },
    ] as PlanSlot[];
    expect(upcomingDishes(plan, book).map((s) => s.slot_id)).toEqual([4, 5]);
  });
});

describe('recipe book with Cook anything entries', () => {
  const path = entry({ slot_id: 1, slot_order: 1, recipe_title: 'Knife Basics Salad', added_at: '2026-11-08T12:00:00.000Z' });
  const cook = cookAnything({ added_at: '2026-11-10T12:00:00.000Z' });

  it('sorts a null slot_id entry by date and never throws on ties', () => {
    expect(sortBookEntries([path, cook]).map(bookEntryKey)).toEqual([`cook:${GEN_ID}`, 'path:1']);
    const tied = [cookAnything({ added_at: null, recipe_title: 'B' }), cookAnything({ added_at: null, recipe_title: 'A', generated_recipe_id: GEN_ID.replace('1', '2') })];
    expect(sortBookEntries(tied).map((e) => e.recipe_title)).toEqual(['A', 'B']);
  });

  it('filters by dish name and by the Cook anything tag', () => {
    expect(filterBookEntries([path, cook], 'pad thai', { 1: 'Knife skills' }).map(bookEntryKey)).toEqual([`cook:${GEN_ID}`]);
    expect(filterBookEntries([path, cook], 'cook anything', {}).map(bookEntryKey)).toEqual([`cook:${GEN_ID}`]);
    expect(filterBookEntries([path, cook], 'knife', { 1: 'Knife skills' }).map(bookEntryKey)).toEqual(['path:1']);
  });

  it('does not treat a Cook anything entry as a finished path slot', () => {
    const plan = [
      { slot_id: 1, slot_order: 1, status: 'done' },
      { slot_id: 2, slot_order: 2, status: 'current' },
    ] as PlanSlot[];
    expect(upcomingDishes(plan, [path, cook]).map((s) => s.slot_id)).toEqual([2]);
  });

  it('routes and targets each kind, and returns null without an id', () => {
    expect(bookEntryRoute(path)).toEqual({ kind: 'path', id: '1' });
    expect(bookEntryRoute(cook)).toEqual({ kind: 'cook-anything', id: GEN_ID });
    expect(bookEntryTarget(path)).toEqual({ kind: 'path', slotId: 1 });
    expect(bookEntryTarget(cook)).toEqual({ kind: 'cook_anything', generatedRecipeId: GEN_ID });
    expect(bookEntryRoute(cookAnything({ generated_recipe_id: null }))).toBeNull();
    expect(bookEntryTarget(entry({ slot_id: null, slot_order: null, recipe_title: 'x' }))).toBeNull();
  });

  it('formats ratings and cook dates', () => {
    expect(formatRating('easy')).toBe('Easy');
    expect(formatRating('ok')).toBe('OK');
    expect(formatRating('hard')).toBe('Hard');
    expect(formatCookDate('2026-11-12T12:00:00.000Z')).toBe('Nov 12, 2026');
    expect(formatCookDate(null)).toBeNull();
    expect(formatCookDate('nope')).toBeNull();
  });
});
