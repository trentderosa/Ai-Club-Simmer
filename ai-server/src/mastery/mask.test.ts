import { describe, it, expect } from 'vitest';
import {
  countedHiddenStepCount,
  HIDDEN_STEP_INSTRUCTION,
  hiddenStepIndices,
  isTrivialStep,
  maskRecipeForMastery,
} from './mask.js';
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

describe('trivial steps (hidden but not counted)', () => {
  it('treats short steps and bare serve/plate/enjoy/garnish steps as trivial', () => {
    for (const instruction of [
      'Serve.',
      'Enjoy!',
      'Plate and serve.',
      'Let it rest.',
      'Serve the chicken warm with the pan juices.',
      'Garnish with fresh parsley and a lemon wedge.',
    ]) {
      expect(isTrivialStep({ instruction }), instruction).toBe(true);
    }
  });

  it('does not treat real tasks as trivial', () => {
    for (const instruction of [
      'Gather and measure all the ingredients.',
      'Season the chicken with salt and pepper.',
      'Mix the herbs into the softened butter.',
      'Serve the chicken with the roasted vegetables, the pan juices, and a green salad on the side.',
    ]) {
      expect(isTrivialStep({ instruction }), instruction).toBe(false);
    }
  });

  it('counts only non-safety, non-trivial steps, but still hides the trivial ones', () => {
    const r: Recipe = {
      ...recipe,
      steps: [
        { instruction: 'Gather and measure all the ingredients.', isSafetyStep: false },
        { instruction: 'Serve.', isSafetyStep: false },
        { instruction: 'Roast at 425F until 165F inside', isSafetyStep: true },
        { instruction: 'Season the chicken with salt and pepper.', isSafetyStep: false },
        { instruction: 'Enjoy!', isSafetyStep: false },
      ],
    };
    expect(countedHiddenStepCount(r)).toBe(2);
    expect(hiddenStepIndices(r)).toEqual([0, 1, 3, 4]);
    const masked = maskRecipeForMastery(r);
    expect(masked.steps[1]).toMatchObject({ isHidden: true, instruction: HIDDEN_STEP_INSTRUCTION });
    expect(masked.steps[4]).toMatchObject({ isHidden: true });
  });
});
