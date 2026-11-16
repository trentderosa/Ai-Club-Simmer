import { describe, it, expect } from 'vitest';
import { HIDDEN_STEP_INSTRUCTION, hiddenStepIndices, maskRecipeForMastery } from './mask.js';
import type { Recipe } from '../schemas/recipe.js';

const recipe: Recipe = {
  title: 'Roast Chicken',
  ingredients: [{ name: 'chicken', amount: '1' }],
  timeEstimateMinutes: 90,
  steps: [
    { instruction: 'Pat the chicken dry', whyItMatters: 'Crisp skin', isSafetyStep: false, techniqueName: 'Pat dry' },
    { instruction: 'Roast at 425F until 165F inside', isSafetyStep: true, techniqueName: 'Check doneness' },
    { instruction: 'Rest 10 minutes', isSafetyStep: false },
  ],
};

describe('F8 mastery masking', () => {
  it('hides every non-safety step', () => {
    expect(hiddenStepIndices(recipe)).toEqual([0, 2]);
  });

  it('replaces hidden text, keeps safety steps and technique names', () => {
    const masked = maskRecipeForMastery(recipe);
    expect(masked.steps[0]).toEqual({ instruction: HIDDEN_STEP_INSTRUCTION, isSafetyStep: false, isHidden: true, techniqueName: 'Pat dry' });
    expect(masked.steps[1]).toEqual(recipe.steps[1]);
    expect(masked.steps[2]).toEqual({ instruction: HIDDEN_STEP_INSTRUCTION, isSafetyStep: false, isHidden: true });
    expect(JSON.stringify(masked)).not.toContain('Pat the chicken dry');
    expect(JSON.stringify(masked)).not.toContain('Crisp skin');
    expect(JSON.stringify(masked)).not.toContain('Rest 10 minutes');
  });

  it('does not change the saved recipe', () => {
    maskRecipeForMastery(recipe);
    expect(recipe.steps[0].instruction).toBe('Pat the chicken dry');
  });
});
