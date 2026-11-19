/**
 * Presentation helpers for the recipe book (F10). The list itself comes from
 * get_my_recipe_book; these functions only shape copy and client-side order.
 */
import type { BookTarget, PlanSlot, Rating, RecipeBookEntry } from '../api';

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

/** Small tag shown on Cook anything rows so they read apart from path recipes. */
export const COOK_ANYTHING_TAG = 'Cook anything';

export function isCookAnything(entry: Pick<RecipeBookEntry, 'kind'>): boolean {
  return entry.kind === 'cook_anything';
}

/** Stable list key: path slots and Cook anything recipes can't collide. */
export function bookEntryKey(entry: RecipeBookEntry): string {
  return entry.kind === 'cook_anything' ? `cook:${entry.generated_recipe_id}` : `path:${entry.slot_id}`;
}

/** Route params for the book detail screen (`/book-entry/[kind]/[id]`). null if the entry has no id. */
export function bookEntryRoute(entry: RecipeBookEntry): { kind: 'path' | 'cook-anything'; id: string } | null {
  if (entry.kind === 'cook_anything') {
    return entry.generated_recipe_id ? { kind: 'cook-anything', id: entry.generated_recipe_id } : null;
  }
  return entry.slot_id === null ? null : { kind: 'path', id: String(entry.slot_id) };
}

/** What to read check-ins for, from the entry. null if the entry has no id. */
export function bookEntryTarget(entry: RecipeBookEntry): BookTarget | null {
  if (entry.kind === 'cook_anything') {
    return entry.generated_recipe_id ? { kind: 'cook_anything', generatedRecipeId: entry.generated_recipe_id } : null;
  }
  return entry.slot_id === null ? null : { kind: 'path', slotId: entry.slot_id };
}

const RATING_LABELS: Record<Rating, string> = { easy: 'Easy', ok: 'OK', hard: 'Hard' };
export function formatRating(rating: Rating): string {
  return RATING_LABELS[rating];
}

/** "Nov 12, 2026" in UTC, for the "Your cooks" list. */
export function formatCookDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Latest first (by added_at, then slot order, then title). The RPC returns path entries first. */
export function sortBookEntries(entries: readonly RecipeBookEntry[]): RecipeBookEntry[] {
  return [...entries].sort((a, b) => {
    const at = a.added_at ? Date.parse(a.added_at) : 0;
    const bt = b.added_at ? Date.parse(b.added_at) : 0;
    if (at !== bt) return bt - at;
    const slotDiff = (b.slot_order ?? 0) - (a.slot_order ?? 0);
    if (slotDiff !== 0) return slotDiff;
    return a.recipe_title.localeCompare(b.recipe_title);
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
    const technique = e.slot_id === null ? '' : (techniqueBySlot[e.slot_id] ?? '');
    const tag = isCookAnything(e) ? COOK_ANYTHING_TAG : '';
    return `${e.recipe_title} ${e.dish_name} ${technique} ${e.label} ${tag}`.toLowerCase().includes(q);
  });
}

/** Path slots that aren't in the book yet, in path order ("Still to come"). */
export function upcomingDishes(plan: readonly PlanSlot[], book: readonly RecipeBookEntry[]): PlanSlot[] {
  const inBook = new Set(book.flatMap((e) => (e.slot_id === null ? [] : [e.slot_id])));
  return plan.filter((s) => !inBook.has(s.slot_id));
}

export const EMPTY_BOOK_COPY = 'Cook a recipe and finish the check-in to add it to your recipe book.';
