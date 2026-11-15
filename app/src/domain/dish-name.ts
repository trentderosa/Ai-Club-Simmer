export const COOK_ANYTHING_MAX_DISH_LENGTH = 80;

export function normalizeDishName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function trimDishQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function clientDishError(raw: string): string | null {
  const trimmed = trimDishQuery(raw);
  if (!trimmed) return 'Type the name of a dish to cook.';
  if (trimmed.length > COOK_ANYTHING_MAX_DISH_LENGTH) {
    return `Keep the dish name to ${COOK_ANYTHING_MAX_DISH_LENGTH} characters or fewer.`;
  }
  if (normalizeDishName(trimmed).replace(/[^\p{L}]/gu, '').length < 2) {
    return 'That doesn’t look like a dish name. Try the name of a meal, like “pad thai”.';
  }
  return null;
}
