import { describe, expect, it } from 'vitest';
import { RecipeSchema } from '../schemas/recipe.js';
import { FreeformRecipeSchema } from './recipe-schema.js';

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { instruction: 'Boil water.', isSafetyStep: true, ...overrides };
}

function ingredient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'eggs', amount: '2', ...overrides };
}

function recipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Fake Eggs',
    ingredients: [ingredient()],
    timeEstimateMinutes: 10,
    steps: [step()],
    ...overrides,
  };
}

const many = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

describe('FreeformRecipeSchema', () => {
  it('accepts a valid minimal recipe and leaves coachNote absent', () => {
    const result = FreeformRecipeSchema.safeParse(recipe());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(recipe());
  });

  it('accepts coachNote when provided', () => {
    expect(FreeformRecipeSchema.parse(recipe({ coachNote: 'Nice.' })).coachNote).toBe('Nice.');
  });

  it.each(['title', 'ingredients', 'timeEstimateMinutes', 'steps'])(
    'rejects a missing %s',
    (field) => {
      const input: Record<string, unknown> = recipe();
      delete input[field];
      expect(FreeformRecipeSchema.safeParse(input).success).toBe(false);
    }
  );

  it('rejects wrong types', () => {
    expect(FreeformRecipeSchema.safeParse(recipe({ title: 1 })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ ingredients: 'x' })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ steps: 'x' })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: '10' })).success).toBe(
      false
    );
    expect(FreeformRecipeSchema.safeParse(null).success).toBe(false);
  });

  it('inherits title, coachNote and nested item bounds from RecipeSchema', () => {
    expect(FreeformRecipeSchema.safeParse(recipe({ title: '' })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ title: 'a'.repeat(200) })).success).toBe(true);
    expect(FreeformRecipeSchema.safeParse(recipe({ title: 'a'.repeat(201) })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ coachNote: 'a'.repeat(500) })).success).toBe(
      true
    );
    expect(FreeformRecipeSchema.safeParse(recipe({ coachNote: 'a'.repeat(501) })).success).toBe(
      false
    );
    expect(
      FreeformRecipeSchema.safeParse(recipe({ ingredients: [ingredient({ name: '' })] })).success
    ).toBe(false);
    expect(
      FreeformRecipeSchema.safeParse(recipe({ steps: [step({ instruction: 'a'.repeat(1001) })] }))
        .success
    ).toBe(false);
  });

  it('enforces ingredients count 1..200', () => {
    expect(FreeformRecipeSchema.safeParse(recipe({ ingredients: [] })).success).toBe(false);
    expect(
      FreeformRecipeSchema.safeParse(recipe({ ingredients: many(1, ingredient) })).success
    ).toBe(true);
    expect(
      FreeformRecipeSchema.safeParse(recipe({ ingredients: many(200, ingredient) })).success
    ).toBe(true);
    expect(
      FreeformRecipeSchema.safeParse(recipe({ ingredients: many(201, ingredient) })).success
    ).toBe(false);
  });

  it('enforces steps count 1..200', () => {
    expect(FreeformRecipeSchema.safeParse(recipe({ steps: [] })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ steps: many(1, step) })).success).toBe(true);
    expect(FreeformRecipeSchema.safeParse(recipe({ steps: many(200, step) })).success).toBe(true);
    expect(FreeformRecipeSchema.safeParse(recipe({ steps: many(201, step) })).success).toBe(false);
  });

  it('enforces timeEstimateMinutes as an integer in 1..10000', () => {
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: 0 })).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: -1 })).success).toBe(
      false
    );
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: 1 })).success).toBe(true);
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: 10_000 })).success).toBe(
      true
    );
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: 10_001 })).success).toBe(
      false
    );
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: 2.5 })).success).toBe(
      false
    );
    expect(FreeformRecipeSchema.safeParse(recipe({ timeEstimateMinutes: NaN })).success).toBe(
      false
    );
  });

  it('accepts sizes beyond the path-slot RecipeSchema limits', () => {
    const big = recipe({
      ingredients: many(51, ingredient),
      steps: many(31, step),
      timeEstimateMinutes: 1441,
    });
    expect(RecipeSchema.safeParse(big).success).toBe(false);
    expect(FreeformRecipeSchema.safeParse(big).success).toBe(true);
  });
});
