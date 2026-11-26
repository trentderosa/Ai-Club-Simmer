const MAX_DIETARY_NEEDS = 20; // DietaryNeedsSchema max

/** Stored needs first, then body needs; case-insensitive dedupe, capped at the schema max. */
export function mergeDietaryNeeds(stored: readonly string[] | undefined, added: readonly string[] | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const need of [...(stored ?? []), ...(added ?? [])]) {
    const key = need.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(need.trim());
    if (merged.length >= MAX_DIETARY_NEEDS) break;
  }
  return merged;
}
