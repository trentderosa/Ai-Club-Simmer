/**
 * In-memory "retry after" map used by the dish photo and dish video finders.
 * Expired keys are dropped on write, and the map is capped so a burst of
 * distinct failures cannot grow without bound.
 */
export const DEFAULT_COOLDOWN_MAX_ENTRIES = 500;

export function rememberUntil(
  map: Map<string, number>,
  key: string,
  until: number,
  now: number,
  maxEntries = DEFAULT_COOLDOWN_MAX_ENTRIES
): void {
  for (const [existing, expiry] of map) {
    if (expiry <= now) map.delete(existing);
  }
  map.set(key, until);
  if (map.size <= maxEntries) return;
  const overflow = map.size - maxEntries;
  const oldest = [...map.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < overflow; i += 1) {
    map.delete(oldest[i][0]);
  }
}
