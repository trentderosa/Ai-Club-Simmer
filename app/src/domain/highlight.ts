/**
 * Splits a cook-mode instruction into plain and highlighted runs, so the
 * ingredient words stand out ("Add the *carrot* and *broccoli*").
 */
import type { Ingredient } from '../api/schemas';

export interface TextRun {
  text: string;
  highlight: boolean;
}

const SKIP = new Set(['and', 'the', 'cup', 'cups', 'tbsp', 'tsp', 'whole', 'small', 'large', 'fresh']);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "red bell pepper, sliced" -> ["red bell pepper", "pepper"]. */
export function ingredientTerms(ingredients: readonly Ingredient[]): string[] {
  const terms = new Set<string>();
  for (const { name } of ingredients) {
    const base = name.split(',')[0].replace(/\(.*?\)/g, '').trim().toLowerCase();
    if (base.length < 3) continue;
    terms.add(base);
    const words = base.split(/\s+/);
    const head = words[words.length - 1];
    if (head.length >= 3 && !SKIP.has(head)) terms.add(head);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

export function highlightIngredients(instruction: string, ingredients: readonly Ingredient[]): TextRun[] {
  const terms = ingredientTerms(ingredients);
  if (!terms.length) return [{ text: instruction, highlight: false }];
  const re = new RegExp(`\\b(${terms.map(escapeRe).join('|')})(?:e?s)?\\b`, 'gi');
  const runs: TextRun[] = [];
  let last = 0;
  for (const m of instruction.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) runs.push({ text: instruction.slice(last, i), highlight: false });
    runs.push({ text: m[0], highlight: true });
    last = i + m[0].length;
  }
  if (last < instruction.length) runs.push({ text: instruction.slice(last), highlight: false });
  return runs;
}
