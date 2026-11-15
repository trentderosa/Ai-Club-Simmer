/**
 * F8 mastery-challenge helpers. Safety steps use the recipe field
 * `isSafetyStep` (CLIENT_API / RecipeSchema). Hidden steps are every
 * other step; they start hidden and may be revealed one at a time.
 *
 * Finishing the cook and checking in completes the slot (XP and path
 * progress are unchanged). The mastery badge is awarded only when the
 * check-in has revealed_steps = 0. A missing payload earns no badge.
 * Reveal counts are client-reported.
 */

export interface MasteryCounts {
  hidden_steps: number;
  revealed_steps: number;
}

export function isHiddenMasteryStep(step: { isSafetyStep: boolean }): boolean {
  return !step.isSafetyStep;
}

/** Indices of steps that start hidden in challenge mode (non-safety). */
export function hiddenStepIndices(steps: readonly { isSafetyStep: boolean }[]): number[] {
  return steps.flatMap((step, i) => (isHiddenMasteryStep(step) ? [i] : []));
}

export function hiddenStepCount(steps: readonly { isSafetyStep: boolean }[]): number {
  return hiddenStepIndices(steps).length;
}

/**
 * Build the check-in `mastery` payload from the recipe and the set of
 * revealed step indices. Only hidden (non-safety) steps count; revealing
 * a safety step is ignored, and `revealed_steps` never exceeds `hidden_steps`.
 */
export function masteryCountsFromReveals(
  steps: readonly { isSafetyStep: boolean }[],
  revealedIndices: ReadonlySet<number> | readonly number[],
): MasteryCounts {
  const hidden = hiddenStepIndices(steps);
  const revealed = revealedIndices instanceof Set ? revealedIndices : new Set(revealedIndices);
  const revealedHidden = hidden.filter((i) => revealed.has(i)).length;
  return { hidden_steps: hidden.length, revealed_steps: revealedHidden };
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

/** True only when a payload is present and revealed_steps is 0. */
export function qualifiesForMasteryBadge(counts: MasteryCounts | null | undefined): boolean {
  return counts != null && isValidMasteryCounts(counts) && counts.revealed_steps === 0;
}
