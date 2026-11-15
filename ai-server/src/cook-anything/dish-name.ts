import { COOK_ANYTHING_MAX_DISH_LENGTH } from './constants.js';

export type DishValidationErrorCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'JUNK'
  | 'INJECTION';

export class DishValidationError extends Error {
  constructor(readonly code: DishValidationErrorCode, message: string) {
    super(message);
    this.name = 'DishValidationError';
  }
}

/**
 * Lowercase, trim, collapse whitespace, strip punctuation.
 * Used as the reuse-cache key and the 50% repeat-XP key.
 */
export function normalizeDishName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\b.{0,40}\b(previous|prior|above)\b.{0,20}\b(instructions?|prompt|rules?)\b/i,
  /\bforget\b.{0,40}\b(previous|prior|above|your)\b.{0,20}\b(instructions?|prompt|rules?)\b/i,
  /\byou are now\b/i,
  /\bsystem\s*:/i,
  /<\s*\/?\s*(system|instruction|user_data)\b/i,
  /\bdo not follow\b.{0,30}\b(rules?|instructions?)\b/i,
  /\boverride\b.{0,30}\b(instructions?|prompt|rules?)\b/i,
];

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/**
 * Trim, cap length, reject empty / junk / prompt-injection-ish input.
 * On success, returns the trimmed original (for display) and the normalized name.
 */
export function validateDishQuery(
  raw: unknown,
  maxLength = COOK_ANYTHING_MAX_DISH_LENGTH
): { dishQuery: string; normalizedDishName: string } {
  if (typeof raw !== 'string') {
    throw new DishValidationError('EMPTY', 'Type the name of a dish to cook.');
  }
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new DishValidationError('EMPTY', 'Type the name of a dish to cook.');
  }
  if (trimmed.length > maxLength) {
    throw new DishValidationError(
      'TOO_LONG',
      `Keep the dish name to ${maxLength} characters or fewer.`
    );
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new DishValidationError(
      'INJECTION',
      'That doesn’t look like a dish name. Try the name of a meal, like “pad thai”.'
    );
  }
  const normalized = normalizeDishName(trimmed);
  if (normalized.length === 0 || letterCount(normalized) < 2) {
    throw new DishValidationError(
      'JUNK',
      'That doesn’t look like a dish name. Try the name of a meal, like “pad thai”.'
    );
  }
  return { dishQuery: trimmed, normalizedDishName: normalized };
}
