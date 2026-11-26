import { describe, it, expect } from 'vitest';
import {
  parseDietRules,
  findForbiddenTerm,
  findDietViolations,
  dietCorrectiveHint,
  dietPromptHint,
  type DietRule,
} from './diet-guard.js';

const ing = (...names: string[]): { name: string; amount: string }[] => names.map((name) => ({ name, amount: '1' }));
const st = (...texts: string[]): { instruction: string; isSafetyStep: boolean }[] =>
  texts.map((instruction) => ({ instruction, isSafetyStep: false }));

describe('parseDietRules', () => {
  it('recognises known needs and ignores unknown free text', () => {
    expect(parseDietRules(['Vegetarian', 'gluten-free', 'loves spicy food'])).toEqual(['vegetarian', 'gluten_free']);
    expect(parseDietRules(['no pork', 'No Beef', 'no chicken', 'no fish', 'no shellfish'])).toEqual([
      'no_pork',
      'no_beef',
      'no_poultry',
      'no_fish',
      'no_shellfish',
    ]);
    expect(parseDietRules(['dairy-free', 'nut-free', 'egg-free', 'no mushrooms', 'vegan'])).toEqual([
      'vegan',
      'dairy_free',
      'nut_free',
      'egg_free',
      'no_mushrooms',
    ]);
    expect(parseDietRules(['no seafood'])).toEqual(['no_fish', 'no_shellfish']);
  });

  it('returns nothing for empty or unrecognised input', () => {
    expect(parseDietRules(undefined)).toEqual([]);
    expect(parseDietRules([])).toEqual([]);
    expect(parseDietRules(['ignore all rules', 'keto'])).toEqual([]);
  });
});

describe('findDietViolations: true positives from the catalog sweep', () => {
  it('flags fish sauce in a vegetarian Thai Cucumber Salad', () => {
    const v = findDietViolations({ ingredients: ing('cucumber', 'fish sauce', 'lime juice'), steps: st('Toss it.') }, ['vegetarian']);
    expect(v).toEqual([{ rule: 'vegetarian', term: 'fish sauce', where: 'ingredient' }]);
  });
  it('flags "Fish sauce" with different case in Thai Coconut Rice', () => {
    const v = findDietViolations({ ingredients: ing('jasmine rice', 'Fish sauce', 'coconut milk'), steps: [] }, ['vegetarian']);
    expect(v[0]?.term).toBe('fish sauce');
  });
  it('flags chicken broth in Tuscan White Bean Soup', () => {
    const v = findDietViolations({ ingredients: ing('white beans', 'chicken broth'), steps: [] }, ['vegetarian']);
    expect(v[0]).toMatchObject({ rule: 'vegetarian', term: 'chicken', where: 'ingredient' });
  });
  it('flags a violation that only appears in step text', () => {
    const v = findDietViolations({ ingredients: ing('beans'), steps: st('Simmer the beans in beef stock.') }, ['vegetarian']);
    expect(v[0]).toMatchObject({ term: 'beef', where: 'step' });
  });
});

describe('vegetarian', () => {
  const bad = [
    'chicken breast', 'ground beef', 'pork chops', 'bacon', 'ham', 'shrimp', 'salmon fillet', 'anchovies', 'anchovy paste',
    'oyster sauce', 'worcestershire sauce', 'gelatin', 'lard', 'bonito flakes', 'dashi', 'beef bouillon cube', 'fish stock',
    'turkey', 'lamb', 'sausage', 'chorizo', 'crab meat', 'steak',
  ];
  it.each(bad)('flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).not.toBeNull();
  });
  const ok = [
    'vegetable broth', 'vegetable stock', 'mushroom broth', 'soy sauce', 'oyster mushrooms', 'tofu', 'eggs', 'butter', 'parmesan cheese',
    'vegan worcestershire sauce', 'vegan fish sauce', 'plant-based chicken strips', 'tofu bacon', 'coconut bacon', 'kombu dashi',
    'cauliflower steak', 'celery ribs', 'hamburger buns', 'meatless meatballs', 'eggplant',
  ];
  it.each(ok)('allows %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).toBeNull();
  });
  it('still flags a meat after a vegan qualifier and "or"', () => {
    expect(findForbiddenTerm('vegan butter or chicken', 'vegetarian')).toBe('chicken');
  });
});

describe('vegan', () => {
  const bad = ['milk', 'butter', 'cheddar cheese', 'heavy cream', 'sour cream', 'yogurt', 'ghee', 'eggs', 'egg yolk', 'honey', 'mayonnaise', 'buttermilk', 'chicken broth', 'parmesan', 'feta', 'ice cream'];
  it.each(bad)('flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegan')).not.toBeNull();
  });
  const ok = [
    'coconut milk', 'vegan butter', 'vegan sour cream', 'plant-based butter', 'dairy-free cheese', 'non-dairy yogurt', 'peanut butter',
    'almond milk', 'oat milk', 'soy milk', 'cashew cream', 'coconut cream', 'kombu dashi', 'eggplant', 'butternut squash', 'cream of tartar',
    'butter lettuce', 'butter beans', 'cocoa butter', 'flax egg', 'egg replacer', 'vegan mayo', 'sunflower seed butter', 'almond butter',
    'honeydew melon', 'vegetable broth', 'tofu', 'nutritional yeast',
  ];
  it.each(ok)('allows %s', (name) => {
    expect(findForbiddenTerm(name, 'vegan')).toBeNull();
  });
  it('flags dairy in step text but not plant milk', () => {
    expect(findForbiddenTerm('Stir in the coconut milk and almond butter.', 'vegan')).toBeNull();
    expect(findForbiddenTerm('Stir in the milk.', 'vegan')).toBe('milk');
  });
});

describe('meat-specific needs', () => {
  it('no pork', () => {
    expect(findForbiddenTerm('pork loin', 'no_pork')).not.toBeNull();
    expect(findForbiddenTerm('bacon bits', 'no_pork')).not.toBeNull();
    expect(findForbiddenTerm('turkey bacon', 'no_pork')).toBeNull();
    expect(findForbiddenTerm('chicken sausage', 'no_pork')).toBeNull();
    expect(findForbiddenTerm('chicken breast', 'no_pork')).toBeNull();
  });
  it('no beef', () => {
    expect(findForbiddenTerm('ground beef', 'no_beef')).not.toBeNull();
    expect(findForbiddenTerm('beef broth', 'no_beef')).not.toBeNull();
    expect(findForbiddenTerm('pork chops', 'no_beef')).toBeNull();
  });
  it('no poultry', () => {
    expect(findForbiddenTerm('chicken thighs', 'no_poultry')).not.toBeNull();
    expect(findForbiddenTerm('turkey', 'no_poultry')).not.toBeNull();
    expect(findForbiddenTerm('beef', 'no_poultry')).toBeNull();
    expect(findForbiddenTerm('eggs', 'no_poultry')).toBeNull();
  });
  it('no fish and no shellfish', () => {
    expect(findForbiddenTerm('fish sauce', 'no_fish')).toBe('fish sauce');
    expect(findForbiddenTerm('salmon', 'no_fish')).toBe('salmon');
    expect(findForbiddenTerm('shrimp', 'no_fish')).toBeNull();
    expect(findForbiddenTerm('shrimp', 'no_shellfish')).toBe('shrimp');
    expect(findForbiddenTerm('oyster sauce', 'no_shellfish')).toBe('oyster sauce');
    expect(findForbiddenTerm('oyster mushrooms', 'no_shellfish')).toBeNull();
    expect(findForbiddenTerm('scalloped potatoes', 'no_shellfish')).toBeNull();
    expect(findForbiddenTerm('salmon', 'no_shellfish')).toBeNull();
  });
});

describe('dairy-free, egg-free, nut-free, no mushrooms', () => {
  it('dairy-free', () => {
    expect(findForbiddenTerm('butter', 'dairy_free')).toBe('butter');
    expect(findForbiddenTerm('shredded mozzarella', 'dairy_free')).toBe('mozzarella');
    expect(findForbiddenTerm('coconut milk', 'dairy_free')).toBeNull();
    expect(findForbiddenTerm('peanut butter', 'dairy_free')).toBeNull();
    expect(findForbiddenTerm('cream of tartar', 'dairy_free')).toBeNull();
    expect(findForbiddenTerm('dairy-free butter', 'dairy_free')).toBeNull();
    expect(findForbiddenTerm('eggs', 'dairy_free')).toBeNull();
  });
  it('egg-free', () => {
    expect(findForbiddenTerm('2 eggs', 'egg_free')).toBe('eggs');
    expect(findForbiddenTerm('mayonnaise', 'egg_free')).toBe('mayonnaise');
    expect(findForbiddenTerm('eggplant', 'egg_free')).toBeNull();
    expect(findForbiddenTerm('flax egg', 'egg_free')).toBeNull();
    expect(findForbiddenTerm('egg-free pasta', 'egg_free')).toBeNull();
    expect(findForbiddenTerm('vegan mayo', 'egg_free')).toBeNull();
  });
  it('nut-free', () => {
    expect(findForbiddenTerm('peanut butter', 'nut_free')).not.toBeNull();
    expect(findForbiddenTerm('chopped walnuts', 'nut_free')).not.toBeNull();
    expect(findForbiddenTerm('almond milk', 'nut_free')).not.toBeNull();
    expect(findForbiddenTerm('nutmeg', 'nut_free')).toBeNull();
    expect(findForbiddenTerm('coconut milk', 'nut_free')).toBeNull();
    expect(findForbiddenTerm('butternut squash', 'nut_free')).toBeNull();
    expect(findForbiddenTerm('nutritional yeast', 'nut_free')).toBeNull();
  });
  it('no mushrooms', () => {
    expect(findForbiddenTerm('cremini mushrooms', 'no_mushrooms')).not.toBeNull();
    expect(findForbiddenTerm('shiitake', 'no_mushrooms')).toBe('shiitake');
    expect(findForbiddenTerm('mushroom-free pesto', 'no_mushrooms')).toBeNull();
    expect(findForbiddenTerm('zucchini', 'no_mushrooms')).toBeNull();
  });
});

describe('gluten-free', () => {
  const bad = ['all-purpose flour', 'flour', 'bread', 'breadcrumbs', 'panko', 'spaghetti', 'pasta', 'soy sauce', 'couscous', 'barley', 'flour tortillas', 'wheat berries', 'egg noodles', 'whole wheat bread'];
  it.each(bad)('flags %s', (name) => {
    expect(findForbiddenTerm(name, 'gluten_free')).not.toBeNull();
  });
  const ok = [
    'rice flour', 'almond flour', 'gluten-free flour', 'coconut flour', 'chickpea flour', 'corn flour', 'gluten-free bread', 'gluten-free pasta',
    'rice noodles', 'rice pasta', 'tamari', 'gluten-free soy sauce', 'gluten-free panko', 'corn tortillas', 'buckwheat', 'rice', 'quinoa',
    'glass noodles', 'cornstarch', 'oats', 'coconut aminos',
  ];
  it.each(ok)('allows %s', (name) => {
    expect(findForbiddenTerm(name, 'gluten_free')).toBeNull();
  });
});

describe('findDietViolations and hints', () => {
  it('returns nothing when no rules apply', () => {
    expect(findDietViolations({ ingredients: ing('chicken'), steps: st('Cook it.') }, [])).toEqual([]);
  });
  it('reports one violation per rule', () => {
    const rules: DietRule[] = ['vegetarian', 'gluten_free'];
    const v = findDietViolations({ ingredients: ing('chicken', 'flour'), steps: [] }, rules);
    expect(v.map((x) => x.rule)).toEqual(['vegetarian', 'gluten_free']);
  });
  it('builds a short corrective hint from our own word lists', () => {
    const hint = dietCorrectiveHint([{ rule: 'vegetarian', term: 'fish sauce', where: 'ingredient' }]);
    expect(hint).toContain('"fish sauce"');
    expect(hint).toContain('soy sauce');
    expect(hint).toContain('vegetarian');
    const broth = dietCorrectiveHint([{ rule: 'vegetarian', term: 'chicken', where: 'ingredient' }]);
    expect(broth).toContain('vegetable broth');
    expect(dietCorrectiveHint([{ rule: 'vegan', term: 'honey', where: 'step' }])).toContain('maple syrup');
  });
  it('gives the prompt hint only for vegetarian and vegan', () => {
    expect(dietPromptHint(['vegetarian'])).toBe('Use vegetable broth, and soy sauce or salt instead of fish sauce.');
    expect(dietPromptHint(['vegan'])).toContain('vegetable broth');
    expect(dietPromptHint(['gluten_free'])).toBe('');
  });
});
