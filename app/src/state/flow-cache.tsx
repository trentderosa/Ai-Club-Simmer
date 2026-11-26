/**
 * In-memory cache for one cooking session's flow: Today -> Recipe -> Cook ->
 * Check-in -> Complete. It avoids re-fetching the plan and recipe on every
 * screen and hands the check-in result to the session-complete screen without
 * stuffing JSON into route params. Nothing is persisted.
 */
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';

import type { CheckInResponse, CookAnythingResponse, PlanSlot, PlanSummary, RecipeResponse } from '../api';
import type { MasteryRun } from '../domain/mastery';

/** The server-side mastery run for the final slot (F8). */
export type MasterySession = MasteryRun;

export interface CheckInOutcome {
  slot: PlanSlot;
  response: CheckInResponse;
  /** Summaries read right before and after the check-in; null if a read failed. */
  summaryBefore: PlanSummary | null;
  summaryAfter: PlanSummary | null;
  /** The plan re-read after the check-in (the next slot is now current). */
  planAfter: PlanSlot[] | null;
}

export interface FlowCache {
  getPlan(): PlanSlot[] | null;
  setPlan(plan: PlanSlot[]): void;
  getSummary(): PlanSummary | null;
  setSummary(s: PlanSummary): void;
  getRecipe(slotId: number): RecipeResponse | null;
  setRecipe(slotId: number, r: RecipeResponse): void;
  getOutcome(slotId: number): CheckInOutcome | null;
  setOutcome(o: CheckInOutcome): void;
  getGenerated(id: string): CookAnythingResponse | null;
  setGenerated(id: string, r: CookAnythingResponse): void;
  getGeneratedOutcome(id: string): GeneratedCheckInOutcome | null;
  setGeneratedOutcome(o: GeneratedCheckInOutcome): void;
  getMastery(slotId: number): MasterySession | null;
  setMastery(slotId: number, session: MasterySession): void;
  clearMastery(slotId: number): void;
  /**
   * After personalizing: forget the plan, summary and recipes of every slot
   * that isn't done, since their dish (and so their recipe) may have changed.
   */
  invalidateUnstarted(): void;
  /** A one-shot message for Today (for example, taste answers weren't saved). */
  setNotice(message: string | null): void;
  takeNotice(): string | null;
  /** Drop everything (sign-out). */
  clear(): void;
}

export interface GeneratedCheckInOutcome {
  recipe: CookAnythingResponse;
  response: CheckInResponse;
  summaryBefore: PlanSummary | null;
  summaryAfter: PlanSummary | null;
}

const Ctx = createContext<FlowCache | null>(null);

export function FlowCacheProvider({ children }: { children: ReactNode }) {
  const ref = useRef({
    plan: null as PlanSlot[] | null,
    summary: null as PlanSummary | null,
    recipes: new Map<number, RecipeResponse>(),
    outcomes: new Map<number, CheckInOutcome>(),
    generated: new Map<string, CookAnythingResponse>(),
    generatedOutcomes: new Map<string, GeneratedCheckInOutcome>(),
    mastery: new Map<number, MasterySession>(),
    notice: null as string | null,
  });
  const cache = useMemo<FlowCache>(() => {
    const c = ref.current;
    return {
      getPlan: () => c.plan,
      setPlan: (p) => (c.plan = p),
      getSummary: () => c.summary,
      setSummary: (s) => (c.summary = s),
      getRecipe: (id) => c.recipes.get(id) ?? null,
      setRecipe: (id, r) => void c.recipes.set(id, r),
      getOutcome: (id) => c.outcomes.get(id) ?? null,
      setOutcome: (o) => void c.outcomes.set(o.slot.slot_id, o),
      getGenerated: (id) => c.generated.get(id) ?? null,
      setGenerated: (id, r) => void c.generated.set(id, r),
      getGeneratedOutcome: (id) => c.generatedOutcomes.get(id) ?? null,
      setGeneratedOutcome: (o) => void c.generatedOutcomes.set(o.recipe.generated_recipe_id, o),
      getMastery: (id) => c.mastery.get(id) ?? null,
      setMastery: (id, session) => void c.mastery.set(id, session),
      clearMastery: (id) => void c.mastery.delete(id),
      invalidateUnstarted: () => {
        const done = new Set((c.plan ?? []).filter((p) => p.status === 'done').map((p) => p.slot_id));
        for (const id of [...c.recipes.keys()]) if (!done.has(id)) c.recipes.delete(id);
        for (const id of [...c.mastery.keys()]) if (!done.has(id)) c.mastery.delete(id);
        c.plan = null;
        c.summary = null;
      },
      setNotice: (m) => void (c.notice = m),
      takeNotice: () => {
        const m = c.notice;
        c.notice = null;
        return m;
      },
      clear: () => {
        c.plan = null;
        c.summary = null;
        c.recipes.clear();
        c.outcomes.clear();
        c.generated.clear();
        c.generatedOutcomes.clear();
        c.mastery.clear();
        c.notice = null;
      },
    };
  }, []);
  return <Ctx.Provider value={cache}>{children}</Ctx.Provider>;
}

export function useFlowCache(): FlowCache {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFlowCache must be used inside <FlowCacheProvider>.');
  return v;
}
