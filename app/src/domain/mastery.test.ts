import { RECIPES } from '../api/mock/fixtures';
import {
  hiddenStepCount,
  hiddenStepIndices,
  isValidMasteryCounts,
  masteryCountsFromReveals,
  revealedLabel,
} from './mastery';

const roast = RECIPES[10];

describe('mastery reveal counting', () => {
  it('treats isSafetyStep as always visible and counts the rest as hidden', () => {
    expect(roast.steps.map((s) => s.isSafetyStep)).toEqual([true, true, false, false, true, false]);
    expect(hiddenStepIndices(roast.steps)).toEqual([2, 3, 5]);
    expect(hiddenStepCount(roast.steps)).toBe(3);
  });

  it('starts at revealed 0 of Y and counts each hidden step only once', () => {
    expect(masteryCountsFromReveals(roast.steps, [])).toEqual({ hidden_steps: 3, revealed_steps: 0 });
    expect(masteryCountsFromReveals(roast.steps, [2])).toEqual({ hidden_steps: 3, revealed_steps: 1 });
    expect(masteryCountsFromReveals(roast.steps, new Set([2, 3, 5]))).toEqual({
      hidden_steps: 3,
      revealed_steps: 3,
    });
    expect(masteryCountsFromReveals(roast.steps, [2, 2, 3])).toEqual({ hidden_steps: 3, revealed_steps: 2 });
  });

  it('ignores safety-step indices and unknown indices so revealed never exceeds hidden', () => {
    const counts = masteryCountsFromReveals(roast.steps, [0, 1, 2, 4, 9, 99]);
    expect(counts).toEqual({ hidden_steps: 3, revealed_steps: 1 });
    expect(isValidMasteryCounts(counts)).toBe(true);
    expect(counts.revealed_steps).toBeLessThanOrEqual(counts.hidden_steps);
  });

  it('keeps the revealed ≤ hidden invariant on an all-safety recipe', () => {
    const onlySafety = [{ isSafetyStep: true }, { isSafetyStep: true }];
    const counts = masteryCountsFromReveals(onlySafety, [0, 1]);
    expect(counts).toEqual({ hidden_steps: 0, revealed_steps: 0 });
    expect(isValidMasteryCounts(counts)).toBe(true);
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
