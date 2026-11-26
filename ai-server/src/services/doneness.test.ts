import { describe, it, expect } from 'vitest';
import { ensureDonenessSteps } from './doneness.js';
import { ensureSafetyFlags } from './recipe-generator.js';
import { countedHiddenStepCount, hiddenStepIndices } from '../mastery/mask.js';
import type { Recipe } from '../schemas/recipe.js';

const step = (instruction: string, isSafetyStep = false): Recipe['steps'][number] => ({ instruction, isSafetyStep });
const recipe = (ingredients: string[], steps: Recipe['steps']): Recipe => ({
  title: 'Test',
  ingredients: ingredients.map((name) => ({ name, amount: '1' })),
  timeEstimateMinutes: 30,
  steps,
});

describe('ensureDonenessSteps', () => {
  it('inserts a 160°F check after the step that cooks ground beef (Beef Chili)', () => {
    const r = recipe(['ground beef', 'kidney beans', 'chili powder'], [
      step('Brown the ground beef in a large pot.', true),
      step('Add the beans and chili powder and simmer for 30 minutes.', true),
      step('Serve the chili hot.'),
    ]);
    const out = ensureDonenessSteps(r);
    expect(out.steps).toHaveLength(4);
    expect(out.steps[1].instruction).toContain('160°F (71°C)');
    expect(out.steps[1].instruction).toContain('ground beef');
    expect(out.steps[1].isSafetyStep).toBe(true);
    expect(out.steps[0]).toBe(r.steps[0]);
  });

  it('inserts a 145°F rest check for pork chops', () => {
    const r = recipe(['pork chops', 'olive oil'], [
      step('Season the pork chops with salt.'),
      step('Sear the pork chops in a hot pan, 4 minutes per side.', true),
      step('Serve with a lemon wedge.'),
    ]);
    const out = ensureDonenessSteps(r);
    expect(out.steps[2].instruction).toMatch(/145°F \(63°C\)/);
    expect(out.steps[2].instruction).toContain('rest');
    expect(out.steps[2].isSafetyStep).toBe(true);
    expect(out.steps).toHaveLength(4);
  });

  it('inserts a fish check for salmon (Teriyaki Salmon)', () => {
    const r = recipe(['salmon fillets', 'teriyaki sauce'], [
      step('Bake the salmon at 400°F for 12 minutes.', true),
      step('Brush with teriyaki sauce and serve.'),
    ]);
    const out = ensureDonenessSteps(r);
    expect(out.steps[1].instruction).toMatch(/145°F \(63°C\).*flake easily/);
  });

  it('inserts an opaque and pink check for shrimp (Garlic Shrimp)', () => {
    const r = recipe(['shrimp', 'garlic', 'butter'], [
      step('Saute the garlic in butter.', true),
      step('Add the shrimp and cook for 3 minutes.', true),
      step('Serve.'),
    ]);
    const out = ensureDonenessSteps(r);
    expect(out.steps[2].instruction).toMatch(/pink and opaque/);
    expect(out.steps[2].isSafetyStep).toBe(true);
  });

  it('does not insert when a step already has a thermometer or target temperature cue', () => {
    const withThermo = recipe(['ground pork'], [
      step('Cook the ground pork until browned.', true),
      step('Check with a thermometer that it is done.', true),
    ]);
    expect(ensureDonenessSteps(withThermo)).toBe(withThermo);
    const withTarget = recipe(['pork loin'], [
      step('Roast the pork loin until it reaches 145°F.', true),
    ]);
    expect(ensureDonenessSteps(withTarget)).toBe(withTarget);
  });

  it('does not count an oven temperature as a doneness cue', () => {
    const r = recipe(['pork tenderloin'], [step('Roast the pork tenderloin in a 400°F oven for 20 minutes.', true)]);
    expect(ensureDonenessSteps(r).steps).toHaveLength(2);
  });

  it('accepts visual cues for fish and shrimp and "no longer pink" for ground meat', () => {
    const fish = recipe(['cod'], [step('Pan fry the cod until it flakes easily.', true)]);
    expect(ensureDonenessSteps(fish)).toBe(fish);
    const shrimp = recipe(['shrimp'], [step('Cook the shrimp until opaque.', true)]);
    expect(ensureDonenessSteps(shrimp)).toBe(shrimp);
    const ground = recipe(['ground beef'], [step('Cook the ground beef until no longer pink.', true)]);
    expect(ensureDonenessSteps(ground)).toBe(ground);
  });

  it('ignores ingredients that need no cooking or are not these proteins', () => {
    for (const name of ['canned tuna', 'smoked salmon', 'fish sauce', 'cooked shrimp', 'dried shrimp', 'cauliflower steak', 'chicken breast', 'tofu', 'eggplant']) {
      const r = recipe([name], [step('Toss everything in a bowl.')]);
      expect(ensureDonenessSteps(r)).toBe(r);
    }
  });

  it('puts the check before a final serve step when no step cooks the protein', () => {
    const r = recipe(['shrimp'], [step('Gather the ingredients.'), step('Serve the shrimp with rice.')]);
    const out = ensureDonenessSteps(r);
    expect(out.steps[1].instruction).toContain('opaque');
    expect(out.steps[2].instruction).toBe('Serve the shrimp with rice.');
  });

  it('with two proteins, a cue for one does not cover the other', () => {
    const r = recipe(['ground beef', 'shrimp'], [
      step('Brown the ground beef.', true),
      step('Check the beef with a thermometer: 160°F.', true),
      step('Cook the shrimp for 3 minutes.', true),
    ]);
    const out = ensureDonenessSteps(r);
    expect(out.steps).toHaveLength(4);
    expect(out.steps[3].instruction).toContain('opaque');
  });

  it('keeps the slot 10 hideable count unchanged and the inserted step is never hidden', () => {
    const r = recipe(['pork chops'], [
      step('Gather and measure all the ingredients on the counter.'),
      step('Season the pork chops with salt and pepper.'),
      step('Sear the pork chops in a hot pan for 4 minutes per side.', true),
      step('Mix the pan sauce ingredients together in a small bowl.'),
    ]);
    const before = countedHiddenStepCount(ensureSafetyFlags(r));
    const out = ensureSafetyFlags(ensureDonenessSteps(r));
    expect(out.steps).toHaveLength(5);
    expect(countedHiddenStepCount(out)).toBe(before);
    const insertedIndex = out.steps.findIndex((s) => s.instruction.includes('145°F'));
    expect(insertedIndex).toBeGreaterThan(-1);
    expect(hiddenStepIndices(out)).not.toContain(insertedIndex);
  });

  it('stops at the step limit', () => {
    const steps = Array.from({ length: 30 }, (_, i) => step(`Cook the shrimp batch number ${i}.`, true));
    const r = recipe(['shrimp'], steps);
    expect(ensureDonenessSteps(r).steps).toHaveLength(30);
  });
});
