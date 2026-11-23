import { describe, expect, it } from 'vitest';
import {
  IngredientSchema,
  MAX_TECHNIQUE_NAME_LENGTH,
  RecipeSchema,
  RecipeStepSchema,
  getRecipeJsonSchema,
} from './recipe.js';

const str = (n: number): string => 'a'.repeat(n);

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

describe('RecipeStepSchema', () => {
  it('accepts a minimal step and leaves optional fields absent', () => {
    const result = RecipeStepSchema.safeParse(step());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ instruction: 'Boil water.', isSafetyStep: true });
    }
  });

  it('accepts all optional fields', () => {
    const full = step({ whyItMatters: 'Safety.', techniqueName: 'dice onion' });
    expect(RecipeStepSchema.parse(full)).toEqual(full);
  });

  it('rejects a missing instruction', () => {
    expect(RecipeStepSchema.safeParse({ isSafetyStep: false }).success).toBe(false);
  });

  it('rejects a missing isSafetyStep', () => {
    expect(RecipeStepSchema.safeParse({ instruction: 'Stir.' }).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(RecipeStepSchema.safeParse(step({ instruction: 5 })).success).toBe(false);
    expect(RecipeStepSchema.safeParse(step({ isSafetyStep: 'true' })).success).toBe(false);
    expect(RecipeStepSchema.safeParse(step({ whyItMatters: 1 })).success).toBe(false);
    expect(RecipeStepSchema.safeParse(step({ techniqueName: 1 })).success).toBe(false);
  });

  it('enforces instruction length 1..1000', () => {
    expect(RecipeStepSchema.safeParse(step({ instruction: '' })).success).toBe(false);
    expect(RecipeStepSchema.safeParse(step({ instruction: str(1) })).success).toBe(true);
    expect(RecipeStepSchema.safeParse(step({ instruction: str(1000) })).success).toBe(true);
    expect(RecipeStepSchema.safeParse(step({ instruction: str(1001) })).success).toBe(false);
  });

  it('enforces whyItMatters max 500 and allows empty', () => {
    expect(RecipeStepSchema.safeParse(step({ whyItMatters: '' })).success).toBe(true);
    expect(RecipeStepSchema.safeParse(step({ whyItMatters: str(500) })).success).toBe(true);
    expect(RecipeStepSchema.safeParse(step({ whyItMatters: str(501) })).success).toBe(false);
  });

  it('enforces techniqueName max (exported constant is 100) and allows empty', () => {
    expect(MAX_TECHNIQUE_NAME_LENGTH).toBe(100);
    expect(RecipeStepSchema.safeParse(step({ techniqueName: '' })).success).toBe(true);
    expect(
      RecipeStepSchema.safeParse(step({ techniqueName: str(MAX_TECHNIQUE_NAME_LENGTH) })).success
    ).toBe(true);
    expect(
      RecipeStepSchema.safeParse(step({ techniqueName: str(MAX_TECHNIQUE_NAME_LENGTH + 1) }))
        .success
    ).toBe(false);
  });
});

describe('IngredientSchema', () => {
  it('accepts a valid ingredient', () => {
    expect(IngredientSchema.parse(ingredient())).toEqual({ name: 'eggs', amount: '2' });
  });

  it('rejects missing fields', () => {
    expect(IngredientSchema.safeParse({ amount: '2' }).success).toBe(false);
    expect(IngredientSchema.safeParse({ name: 'eggs' }).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(IngredientSchema.safeParse(ingredient({ name: 1 })).success).toBe(false);
    expect(IngredientSchema.safeParse(ingredient({ amount: 2 })).success).toBe(false);
  });

  it('enforces name length 1..100', () => {
    expect(IngredientSchema.safeParse(ingredient({ name: '' })).success).toBe(false);
    expect(IngredientSchema.safeParse(ingredient({ name: str(1) })).success).toBe(true);
    expect(IngredientSchema.safeParse(ingredient({ name: str(100) })).success).toBe(true);
    expect(IngredientSchema.safeParse(ingredient({ name: str(101) })).success).toBe(false);
  });

  it('enforces amount length 1..50', () => {
    expect(IngredientSchema.safeParse(ingredient({ amount: '' })).success).toBe(false);
    expect(IngredientSchema.safeParse(ingredient({ amount: str(1) })).success).toBe(true);
    expect(IngredientSchema.safeParse(ingredient({ amount: str(50) })).success).toBe(true);
    expect(IngredientSchema.safeParse(ingredient({ amount: str(51) })).success).toBe(false);
  });
});

describe('RecipeSchema', () => {
  it('accepts a minimal recipe and leaves coachNote absent', () => {
    const result = RecipeSchema.safeParse(recipe());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(recipe());
  });

  it('accepts coachNote when provided', () => {
    expect(RecipeSchema.parse(recipe({ coachNote: 'Nice work.' })).coachNote).toBe('Nice work.');
  });

  it.each(['title', 'ingredients', 'timeEstimateMinutes', 'steps'])(
    'rejects a missing %s',
    (field) => {
      const input: Record<string, unknown> = recipe();
      delete input[field];
      expect(RecipeSchema.safeParse(input).success).toBe(false);
    }
  );

  it('rejects wrong types', () => {
    expect(RecipeSchema.safeParse(recipe({ title: 1 })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ ingredients: 'eggs' })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ steps: 'boil' })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: '10' })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ coachNote: 1 })).success).toBe(false);
    expect(RecipeSchema.safeParse(null).success).toBe(false);
  });

  it('enforces title length 1..200', () => {
    expect(RecipeSchema.safeParse(recipe({ title: '' })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ title: str(1) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ title: str(200) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ title: str(201) })).success).toBe(false);
  });

  it('enforces coachNote max 500 and allows empty', () => {
    expect(RecipeSchema.safeParse(recipe({ coachNote: '' })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ coachNote: str(500) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ coachNote: str(501) })).success).toBe(false);
  });

  it('enforces ingredients count 1..50', () => {
    const many = (n: number): Record<string, unknown>[] => Array.from({ length: n }, () => ingredient());
    expect(RecipeSchema.safeParse(recipe({ ingredients: [] })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ ingredients: many(1) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ ingredients: many(50) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ ingredients: many(51) })).success).toBe(false);
  });

  it('enforces steps count 1..30', () => {
    const many = (n: number): Record<string, unknown>[] => Array.from({ length: n }, () => step());
    expect(RecipeSchema.safeParse(recipe({ steps: [] })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ steps: many(1) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ steps: many(30) })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ steps: many(31) })).success).toBe(false);
  });

  it('validates nested items', () => {
    expect(
      RecipeSchema.safeParse(recipe({ ingredients: [ingredient({ name: '' })] })).success
    ).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ steps: [{ instruction: 'x' }] })).success).toBe(false);
  });

  it('enforces timeEstimateMinutes as an integer in 1..1440', () => {
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: 0 })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: -5 })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: 1 })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: 1440 })).success).toBe(true);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: 1441 })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: 10.5 })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: NaN })).success).toBe(false);
    expect(RecipeSchema.safeParse(recipe({ timeEstimateMinutes: Infinity })).success).toBe(false);
  });

  it('strips unknown keys without failing', () => {
    const result = RecipeSchema.parse(recipe({ extra: 'x' }));
    expect(result).not.toHaveProperty('extra');
  });
});

describe('getRecipeJsonSchema', () => {
  it('requires the same fields as the Zod schema', () => {
    const js = getRecipeJsonSchema() as {
      required: string[];
      properties: Record<string, { items?: { required: string[] } }>;
    };
    expect(js.required).toEqual(['title', 'ingredients', 'timeEstimateMinutes', 'steps']);
    expect(Object.keys(js.properties).sort()).toEqual(
      ['coachNote', 'ingredients', 'steps', 'timeEstimateMinutes', 'title'].sort()
    );
    expect(js.properties.ingredients.items?.required).toEqual(['name', 'amount']);
    expect(js.properties.steps.items?.required).toEqual(['instruction', 'isSafetyStep']);
  });
});
