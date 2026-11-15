/**
 * Labels for onboarding answers on the profile screen, and helpers to round
 * trip the goals string stored on `profiles`.
 */
import type { Profile, ProfileInput } from '../api';

export const EXPERIENCE_OPTIONS: { value: ProfileInput['experience_level']; title: string; subtitle: string }[] = [
  { value: 'never_cooked', title: 'Never, really', subtitle: 'Microwave, cereal, the occasional toast' },
  { value: 'a_little', title: 'A little', subtitle: 'Pasta, eggs, a box mix now and then' },
  { value: 'comfortable', title: 'I’m comfortable', subtitle: 'I follow recipes; I want to stop needing them' },
];

export const GOAL_OPTIONS = ['Cook 3 dinners a week', 'Spend less on takeout', 'Eat healthier', 'Cook for friends', 'Meal prep'] as const;

/** Stored lowercase, as in docs/CLIENT_API.md. */
export const EQUIPMENT_OPTIONS = ['stove', 'oven', 'microwave', 'pan', 'pot', 'sheet pan', 'knife', 'cutting board', 'rice cooker', 'blender'] as const;

export const BUDGET_OPTIONS: { value: ProfileInput['budget']; title: string; subtitle: string }[] = [
  { value: 'low', title: 'Keep it cheap', subtitle: 'Pantry staples, store brands' },
  { value: 'medium', title: 'Somewhere in the middle', subtitle: 'A few fresh things each week' },
  { value: 'high', title: 'Not a big worry', subtitle: 'Happy to buy what the recipe asks for' },
];

export const MINUTES_OPTIONS = [15, 20, 30, 45, 60] as const;
export const DEFAULT_EQUIPMENT = ['stove', 'pan', 'pot', 'knife', 'cutting board'] as const;

const GOAL_SEP = '; ';

export function parseGoals(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(GOAL_SEP)
    .map((g) => g.trim())
    .filter(Boolean);
}

export function joinGoals(goals: readonly string[]): string {
  return goals.join(GOAL_SEP);
}

export function experienceTitle(level: Profile['experience_level']): string | null {
  return EXPERIENCE_OPTIONS.find((o) => o.value === level)?.title ?? null;
}

/** "A little experience" under the name. Cooking levels L1–L4 are post-MVP. */
export function experienceCaption(level: Profile['experience_level']): string | null {
  if (level === 'never_cooked') return 'New to cooking';
  if (level === 'a_little') return 'A little experience';
  if (level === 'comfortable') return 'Comfortable in the kitchen';
  return null;
}

export function budgetTitle(budget: Profile['budget']): string | null {
  return BUDGET_OPTIONS.find((o) => o.value === budget)?.title ?? null;
}

export function capEquipment(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

export function formatEquipmentList(items: readonly string[] | null | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items.map(capEquipment).join(', ');
}

export function formatSchedule(days: number | null | undefined, minutes: number | null | undefined): string | null {
  if (!days || !minutes) return null;
  const dayLabel = days === 1 ? '1 day a week' : `${days} days a week`;
  return `${dayLabel} · ${minutes} min`;
}

/** "Cooking since Nov 2", from profiles.created_at. */
export function formatCookingSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Cooking since ${when}`;
}

export function profileSubtitle(profile: Pick<Profile, 'experience_level' | 'created_at'>): string | null {
  const since = formatCookingSince(profile.created_at);
  const exp = experienceCaption(profile.experience_level);
  if (since && exp) return `${since} · ${exp}`;
  return since ?? exp;
}

export function initialFromName(firstName: string | null | undefined): string {
  const ch = firstName?.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}
