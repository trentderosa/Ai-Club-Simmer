/**
 * Pure re-implementations of the server rules mock mode needs, kept small and
 * tested so the fake data behaves like the real backend:
 * - plan status (get_plan_for_user): done = has a check-in; current = first
 *   not-done slot; everything after it locked
 * - summary (get_plan_summary_for_user), incl. the suggested-sessions rule
 *   (PRD open question 11)
 * - XP (award_slot_xp): first completion = slot XP; repeats 50%, max 100 XP
 *   of repeats per week (PRD F7)
 */
import type { PlanSlot, PlanSummary } from '../schemas';
import type { SlotFixture } from './fixtures';

export const REPEAT_RATE = 0.5;
export const WEEKLY_REPEAT_CAP = 100;

export function derivePlan(
  slots: readonly SlotFixture[],
  completions: Readonly<Record<number, number>>,
  recipeSlots: ReadonlySet<number>,
): PlanSlot[] {
  let currentAssigned = false;
  return [...slots]
    .sort((a, b) => a.slot_order - b.slot_order)
    .map((s) => {
      const times = completions[s.slot_id] ?? 0;
      let status: PlanSlot['status'];
      if (times > 0) status = 'done';
      else if (!currentAssigned) {
        status = 'current';
        currentAssigned = true;
      } else status = 'locked';
      return {
        slot_id: s.slot_id,
        slot_order: s.slot_order,
        dish_name: s.dish_name,
        technique_focus: s.technique_focus,
        xp_value: s.xp_value,
        is_final: s.is_final,
        status,
        has_recipe: recipeSlots.has(s.slot_id),
        times_completed: times,
        first_completed_at: times > 0 ? '2026-11-10T23:00:00.000Z' : null,
      };
    });
}

export function deriveSummary(
  plan: readonly PlanSlot[],
  slots: readonly SlotFixture[],
  totalXp: number,
  schedule: { days_per_week: number; minutes_per_session: number } | null,
): PlanSummary {
  const completed = plan.filter((p) => p.status === 'done').length;
  const current = plan.find((p) => p.status === 'current')?.slot_order ?? null;
  let suggested: number | null = null;
  let weeks: number | null = null;
  if (schedule) {
    const remaining = slots.filter((s) => plan.find((p) => p.slot_id === s.slot_id)?.status !== 'done');
    const pool = remaining.length ? remaining : slots;
    const avg = pool.reduce((n, s) => n + s.cook_minutes, 0) / pool.length;
    suggested =
      avg > 0
        ? Math.min(schedule.days_per_week, Math.max(1, Math.floor((schedule.days_per_week * schedule.minutes_per_session) / avg)))
        : schedule.days_per_week;
    weeks = Math.ceil((plan.length - completed) / suggested);
  }
  return {
    total_xp: totalXp,
    completed_slots: completed,
    total_slots: plan.length,
    current_slot_order: current,
    path_complete: completed === plan.length,
    days_per_week: schedule?.days_per_week ?? null,
    minutes_per_session: schedule?.minutes_per_session ?? null,
    suggested_sessions_per_week: suggested,
    estimated_weeks_remaining: weeks,
  };
}

/** XP for one check-in. `repeatXpThisWeek` is repeat XP already awarded this week. */
export function awardXp(
  slotXp: number,
  isFirstCompletion: boolean,
  repeatXpThisWeek: number,
): { xp_awarded: number; capped: boolean } {
  if (isFirstCompletion) return { xp_awarded: slotXp, capped: false };
  const full = Math.round(slotXp * REPEAT_RATE);
  const room = Math.max(0, WEEKLY_REPEAT_CAP - repeatXpThisWeek);
  const xp = Math.min(full, room);
  return { xp_awarded: xp, capped: xp < full };
}
