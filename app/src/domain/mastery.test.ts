import { RECIPES } from '../api/mock/fixtures';
import {
  HIDDEN_STEP_INSTRUCTION,
  countsForRun,
  displayStep,
  hiddenStepIndices,
  isStepHidden,
  isValidMasteryCounts,
  maskRecipeForMastery,
  qualifiesForMasteryBadge,
  revealedLabel,
  runFromStart,
  runWithReveal,
  type MasteryRun,
} from './mastery';

const roast = RECIPES[10];

describe('mastery masking', () => {
  it('hides every non-safety step', () => {
    expect(roast.steps.map((s) => s.isSafetyStep)).toEqual([true, true, false, false, true, false]);
    expect(hiddenStepIndices(roast.steps)).toEqual([2, 3, 5]);
  });

  it('masks hidden steps like the server and leaves safety steps alone', () => {
    const masked = maskRecipeForMastery(roast);
    expect(masked.steps[2]).toMatchObject({ instruction: HIDDEN_STEP_INSTRUCTION, isHidden: true, isSafetyStep: false });
    expect(masked.steps[2].whyItMatters).toBeUndefined();
    expect(masked.steps[0]).toEqual(roast.steps[0]);
    expect(JSON.stringify(masked)).not.toContain(roast.steps[3].instruction);
  });
});

describe('mastery runs', () => {
  const start = { session_id: '20000000-0000-4000-8000-000000000001', hidden_step_indices: [2, 3, 5], revealed_steps: {} };

  it('starts at revealed 0 of Y', () => {
    const run = runFromStart(start);
    expect(countsForRun(run)).toEqual({ hidden_steps: 3, revealed_steps: 0 });
    expect(isStepHidden(run, 2)).toBe(true);
    expect(isStepHidden(run, 0)).toBe(false);
  });

  it('a reveal swaps in the real step and counts once', () => {
    const masked = maskRecipeForMastery(roast);
    let run: MasteryRun = runFromStart(start);
    const reveal = { step_index: 3, step: roast.steps[3], hidden_step_indices: [2, 3, 5], revealed_step_indices: [3] };
    run = runWithReveal(run, reveal);
    run = runWithReveal(run, reveal);
    expect(countsForRun(run)).toEqual({ hidden_steps: 3, revealed_steps: 1 });
    expect(isStepHidden(run, 3)).toBe(false);
    expect(displayStep(masked, run, 3)).toEqual(roast.steps[3]);
    expect(displayStep(masked, run, 2).isHidden).toBe(true);
  });

  it('resumes the revealed steps from the server', () => {
    const run = runFromStart({ ...start, revealed_steps: { '5': roast.steps[5] } });
    expect(countsForRun(run)).toEqual({ hidden_steps: 3, revealed_steps: 1 });
    expect(run.revealed[5]).toEqual(roast.steps[5]);
  });

  it('formats the cook-mode indicator', () => {
    expect(revealedLabel({ hidden_steps: 3, revealed_steps: 1 })).toBe('Revealed 1 of 3 hidden steps.');
  });
});

describe('isValidMasteryCounts', () => {
  it('accepts revealed equal to hidden and rejects revealed over hidden', () => {
    expect(isValidMasteryCounts({ hidden_steps: 3, revealed_steps: 0 })).toBe(true);
    expect(isValidMasteryCounts({ hidden_steps: 3, revealed_steps: 3 })).toBe(true);
    expect(isValidMasteryCounts({ hidden_steps: 3, revealed_steps: 4 })).toBe(false);
    expect(isValidMasteryCounts({ hidden_steps: -1, revealed_steps: 0 })).toBe(false);
    expect(isValidMasteryCounts({ hidden_steps: 1.5, revealed_steps: 0 })).toBe(false);
  });
});

describe('qualifiesForMasteryBadge', () => {
  it('is true only for a present run with zero reveals', () => {
    expect(qualifiesForMasteryBadge({ hidden_steps: 3, revealed_steps: 0 })).toBe(true);
    expect(qualifiesForMasteryBadge({ hidden_steps: 3, revealed_steps: 1 })).toBe(false);
    expect(qualifiesForMasteryBadge(undefined)).toBe(false);
    expect(qualifiesForMasteryBadge(null)).toBe(false);
  });
});
