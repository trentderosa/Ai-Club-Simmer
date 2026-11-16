/**
 * F8 mastery-challenge helpers.
 *
 * The final path slot is cooked from memory: every non-safety step starts
 * hidden. The ai-server masks those steps in the recipe (`isHidden: true`,
 * placeholder text) and only sends a step's real content through a reveal,
 * which it records in a server-side mastery session. The check-in sends the
 * session id, and the server reads the reveal counts from the session, so the
 * app never reports counts itself.
 *
 * Finishing the cook and checking in completes the slot (XP and path progress
 * are unchanged). The mastery badge needs zero reveals.
 */
import type { MasteryCounts, MasteryRevealResponse, MasteryStartResponse, Recipe, RecipeStep } from '../api/schemas';

export const HIDDEN_STEP_INSTRUCTION = 'Hidden step. Reveal it in cook mode if you need a reminder.';

/** One cook of the final slot: the server session plus the steps revealed so far. */
export interface MasteryRun {
  sessionId: string;
  hiddenIndices: number[];
  /** Full content of each revealed step, by index. */
  revealed: Record<number, RecipeStep>;
}

/** Indices of steps that start hidden in challenge mode (every non-safety step). */
export function hiddenStepIndices(steps: readonly { isSafetyStep: boolean }[]): number[] {
  return steps.flatMap((step, i) => (step.isSafetyStep ? [] : [i]));
}

/**
 * Same masking as the ai-server (ai-server/src/mastery/mask.ts). Used by mock
 * mode so the app sees what the live server sends.
 */
export function maskRecipeForMastery(recipe: Recipe): Recipe {
  return {
    ...recipe,
    steps: recipe.steps.map((step): RecipeStep => {
      if (step.isSafetyStep) return step;
      const masked: RecipeStep = { instruction: HIDDEN_STEP_INSTRUCTION, isSafetyStep: false, isHidden: true };
      if (step.techniqueName) masked.techniqueName = step.techniqueName;
      return masked;
    }),
  };
}

export function runFromStart(res: MasteryStartResponse): MasteryRun {
  const revealed: Record<number, RecipeStep> = {};
  for (const [key, step] of Object.entries(res.revealed_steps)) {
    const i = Number(key);
    if (Number.isInteger(i) && i >= 0) revealed[i] = step;
  }
  return { sessionId: res.session_id, hiddenIndices: [...res.hidden_step_indices], revealed };
}

export function runWithReveal(run: MasteryRun, res: MasteryRevealResponse): MasteryRun {
  return { ...run, hiddenIndices: [...res.hidden_step_indices], revealed: { ...run.revealed, [res.step_index]: res.step } };
}

/** Counts for the cook-mode and check-in labels. Only hidden steps count. */
export function countsForRun(run: MasteryRun): MasteryCounts {
  const hidden = new Set(run.hiddenIndices);
  const revealed = Object.keys(run.revealed)
    .map(Number)
    .filter((i) => hidden.has(i)).length;
  return { hidden_steps: hidden.size, revealed_steps: revealed };
}

/** What cook mode shows for step `i`: the revealed content, or the recipe's step. */
export function displayStep(recipe: Recipe, run: MasteryRun | null, i: number): RecipeStep {
  return run?.revealed[i] ?? recipe.steps[i];
}

/** True while step `i` is still hidden in this run. */
export function isStepHidden(run: MasteryRun | null, i: number): boolean {
  if (!run) return false;
  return run.hiddenIndices.includes(i) && !(i in run.revealed);
}

export function isValidMasteryCounts(counts: MasteryCounts): boolean {
  return (
    Number.isInteger(counts.hidden_steps) &&
    Number.isInteger(counts.revealed_steps) &&
    counts.hidden_steps >= 0 &&
    counts.revealed_steps >= 0 &&
    counts.revealed_steps <= counts.hidden_steps
  );
}

/** Caption shown in cook mode, e.g. "Revealed 1 of 3 hidden steps." */
export function revealedLabel(counts: MasteryCounts): string {
  return `Revealed ${counts.revealed_steps} of ${counts.hidden_steps} hidden steps.`;
}

/** True only when a run is present and nothing was revealed. */
export function qualifiesForMasteryBadge(counts: MasteryCounts | null | undefined): boolean {
  return counts != null && isValidMasteryCounts(counts) && counts.revealed_steps === 0;
}
