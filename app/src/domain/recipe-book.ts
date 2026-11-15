/**
 * Presentation helpers for the recipe book (F10). The list itself comes from
 * get_my_recipe_book; these functions only shape copy and client-side order.
 */
import type { PlanSlot, RecipeBookEntry } from '../api';

/** Shown on the book and on a done recipe, so repeats aren't a surprise. */
export const REPEAT_XP_NOTE = 'Repeats earn 50% XP, up to 100 XP a week.';

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;

/** "Three dishes you can cook." The path has at most 10 slots. */
export function recipeBookHeadline(count: number): string {
  if (count <= 0) return 'Nothing in your book yet.';
  const word = count <= 10 ? COUNT_WORDS[count] : String(count);
  const noun = count === 1 ? 'dish' : 'dishes';
  return `${word[0].toUpperCase()}${word.slice(1)} ${noun} you can cook.`;
}

export function formatBookLabel(label: RecipeBookEntry['label'], timesCooked: number): string {
  const base = label === 'mastered' ? 'Mastered' : 'Completed';
  if (timesCooked > 1) return `${base} · cooked ${timesCooked}×`;
  return base;
}

/** "Added Nov 12". Uses UTC so a date-only timestamp stays on that calendar day. */
export function formatAddedOn(iso: string | null | undefined): string | null {
  const text = formatShortDate(iso);
  return text ? `Added ${text}` : null;
}

export function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Latest first (by added_at, then slot order). The RPC returns path order. */
export function sortBookEntries(entries: readonly RecipeBookEntry[]): RecipeBookEntry[] {
  return [...entries].sort((a, b) => {
    const at = a.added_at ? Date.parse(a.added_at) : 0;
    const bt = b.added_at ? Date.parse(b.added_at) : 0;
    if (at !== bt) return bt - at;
    return b.slot_order - a.slot_order;
  });
}

export function filterBookEntries(
  entries: readonly RecipeBookEntry[],
  query: string,
  techniqueBySlot: Readonly<Record<number, string>> = {},
): RecipeBookEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => {
    const technique = techniqueBySlot[e.slot_id] ?? '';
    return `${e.recipe_title} ${e.dish_name} ${technique} ${e.label}`.toLowerCase().includes(q);
  });
}

/** Path slots that aren't in the book yet, in path order ("Still to come"). */
export function upcomingDishes(plan: readonly PlanSlot[], book: readonly RecipeBookEntry[]): PlanSlot[] {
  const inBook = new Set(book.map((e) => e.slot_id));
  return plan.filter((s) => !inBook.has(s.slot_id));
}

export const EMPTY_BOOK_COPY = 'Cook a recipe and finish the check-in to add it to your recipe book.';
