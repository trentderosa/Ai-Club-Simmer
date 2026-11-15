/** Seal labels and counts for the F9 badge shelf on the profile. */
import type { Badge, BadgeKind } from '../api';

/** Direction A: 01–09 for completion, M for mastery, 10 for the path graduate. */
export function badgeSealLabel(badge: Pick<Badge, 'kind' | 'sort_order'>): string {
  if (badge.kind === 'mastery') return 'M';
  if (badge.kind === 'path_milestone') return '10';
  return String(badge.sort_order).padStart(2, '0');
}

export function badgeCounts(badges: readonly Badge[]): { earned: number; total: number } {
  return { earned: badges.filter((b) => b.earned).length, total: badges.length };
}

export function isBadgeKind(kind: string): kind is BadgeKind {
  return kind === 'completion' || kind === 'mastery' || kind === 'path_milestone';
}
