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

describe('review fixes: scoped qualifiers', () => {
  const flagged: Array<[DietRule, string, string]> = [
    ['vegetarian', 'dairy-free chicken alfredo', 'chicken'],
    ['vegetarian', 'eggless chicken fried rice', 'chicken'],
    ['vegetarian', 'Stir in the veggie and beef mixture', 'beef'],
    ['vegetarian', 'vegetable beef soup', 'beef'],
    ['vegetarian', 'coconut chicken', 'chicken'],
    ['vegetarian', 'mushroom beef stir-fry', 'beef'],
    ['vegetarian', 'soy chicken', 'chicken'],
    ['no_pork', 'dairy-free pork sausage', 'pork'],
    ['egg_free', 'dairy-free egg noodles', 'egg'],
    ['egg_free', 'vegan egg wash with real egg', 'egg'],
    ['vegan', 'plant-based milk and eggs', 'eggs'],
    ['vegetarian', 'veggie bacon bits and ham', 'ham'],
    ['vegetarian', 'beyond meat and bacon', 'bacon'],
    ['dairy_free', 'nut butter and cream', 'cream'],
    ['vegan', 'vegan sour cream and cheddar', 'cheddar'],
    ['vegan', 'dairy-free chocolate chips and butter', 'butter'],
    ['no_fish', 'salmon steak', 'salmon'],
    ['no_fish', 'tuna steak', 'tuna'],
    ['vegetarian', 'salmon steak', 'salmon'],
  ];
  it.each(flagged)('%s flags %s', (rule, text, term) => {
    expect(findForbiddenTerm(text, rule)).toBe(term);
  });

  const allowed: Array<[DietRule, string]> = [
    ['vegetarian', 'vegetarian fish sauce'],
    ['vegetarian', 'vegetarian oyster sauce'],
    ['vegetarian', 'vegan fish sauce'],
    ['vegetarian', 'meat thermometer'],
    ['vegetarian', 'tofu bacon'],
    ['vegetarian', 'jackfruit chicken'],
    ['vegetarian', 'beyond meat'],
    ['vegetarian', 'goat cheese'],
    ['vegan', 'dairy-free milk chocolate'],
    ['vegan', 'egg-free mayonnaise'],
    ['vegan', 'vegan egg wash'],
    ['vegetarian', 'Sear the portobello steaks until browned.'],
    ['vegetarian', 'eggplant steak'],
    ['pescatarian', 'salmon steak'],
    ['pescatarian', 'shrimp and cod'],
  ];
  it.each(allowed)('%s allows %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).toBeNull();
  });
});

describe('review fixes: more words and diacritics', () => {
  const veg = ['guanciale', 'lardons', 'kielbasa', 'andouille', 'bratwurst', 'mortadella', 'pastrami', 'spam', 'goat', 'schmaltz', 'katsuobushi', 'nuoc mam', 'corned beef', 'pork rinds', 'dried shrimp', 'squid ink'];
  it.each(veg)('vegetarian flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).not.toBeNull();
  });
  const vegan = ['pecorino', 'cotija', 'queso fresco', 'labneh', 'kefir', 'egg yolks', 'yolks', 'aioli', 'crème fraîche', 'Crème Fraîche'];
  it.each(vegan)('vegan flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegan')).not.toBeNull();
  });
  it('pescatarian allows fish but not meat', () => {
    expect(findForbiddenTerm('chicken', 'pescatarian')).toBe('chicken');
    expect(findForbiddenTerm('bacon', 'pescatarian')).toBe('bacon');
    expect(findForbiddenTerm('salmon', 'pescatarian')).toBeNull();
  });
});

describe('review fixes: parseDietRules', () => {
  it('maps extra phrasings', () => {
    expect(parseDietRules(['plant-based'])).toEqual(['vegan']);
    expect(parseDietRules(['lactose intolerant'])).toEqual(['dairy_free']);
    expect(parseDietRules(['nuts'])).toEqual(['nut_free']);
    expect(parseDietRules(['Peanuts'])).toEqual(['nut_free']);
    expect(parseDietRules(['shellfish'])).toEqual(['no_shellfish']);
    expect(parseDietRules(['pescatarian'])).toEqual(['pescatarian']);
  });
  it('does not over-match', () => {
    expect(parseDietRules(['loves nuts and berries'])).toEqual([]);
    expect(parseDietRules(['halal'])).toEqual([]);
  });
});

describe('review fixes: imitation crab and faux qualifiers (S1)', () => {
  const flagged: Array<[DietRule, string]> = [
    ['vegetarian', 'imitation crab'],
    ['vegan', 'imitation crab'],
    ['no_fish', 'imitation crab'],
    ['no_fish', 'imitation crabmeat'],
    ['no_fish', 'surimi'],
    ['no_fish', 'crab sticks'],
    ['no_fish', 'fish cakes'],
    ['vegetarian', 'surimi'],
    ['vegetarian', 'kamaboko'],
    ['no_shellfish', 'imitation crab'],
    ['vegetarian', 'mock turtle soup with veal'],
    ['vegetarian', 'faux chicken nuggets'],
  ];
  it.each(flagged)('%s flags %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).not.toBeNull();
  });
  it('reports imitation crab as a fish term', () => {
    expect(findForbiddenTerm('imitation crab', 'no_fish')).toBe('imitation crab');
    expect(findForbiddenTerm('imitation crab', 'vegetarian')).toBe('imitation crab');
  });
  const allowed: Array<[DietRule, string]> = [
    ['pescatarian', 'imitation crab'],
    ['pescatarian', 'surimi'],
    ['vegetarian', 'vegan imitation crab'],
    ['no_fish', 'plant-based crab cakes'],
    ['vegetarian', 'faux chicken made from tofu'],
    ['vegan', 'mock duck made with seitan'],
    ['vegetarian', 'imitation bacon bits made from soy'],
  ];
  it.each(allowed)('%s allows %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).toBeNull();
  });
});

describe('review fixes: plant burgers, meatballs and buns (S2)', () => {
  const allowed: Array<[DietRule, string]> = [
    ['vegetarian', 'black bean burger'],
    ['vegetarian', 'black bean burgers'],
    ['vegetarian', 'burger buns'],
    ['vegetarian', 'hamburger buns'],
    ['vegan', 'burger buns'],
    ['vegetarian', 'lentil meatballs'],
    ['vegetarian', 'veggie burger'],
    ['vegetarian', 'bean burger'],
    ['vegetarian', 'chickpea burgers'],
    ['vegetarian', 'mushroom burger'],
    ['vegetarian', 'beyond burger'],
    ['vegetarian', 'impossible burger'],
    ['vegetarian', 'tofu meatballs'],
    ['vegan', 'black bean burger patties'],
    ['pescatarian', 'lentil meatballs'],
  ];
  it.each(allowed)('%s allows %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).toBeNull();
  });
  const flagged: Array<[DietRule, string, string]> = [
    ['vegetarian', 'burger', 'burger'],
    ['vegetarian', 'burgers', 'burgers'],
    ['vegetarian', 'hamburger', 'hamburger'],
    ['vegetarian', 'hamburgers', 'hamburgers'],
    ['vegetarian', 'cheeseburger', 'cheeseburger'],
    ['vegetarian', 'meatballs', 'meatballs'],
    ['pescatarian', 'frozen meatballs', 'meatballs'],
    ['vegetarian', 'black bean burger and bacon', 'bacon'],
    ['no_mushrooms', 'mushroom burger', 'mushroom'],
  ];
  it.each(flagged)('%s flags %s', (rule, text, term) => {
    expect(findForbiddenTerm(text, rule)).toBe(term);
  });
  it('a bare "burgers" step is fine once the ingredients name a plant burger', () => {
    const plant = findDietViolations(
      { ingredients: ing('black beans', 'black bean burger patties', 'burger buns'), steps: st('Grill the burgers for 4 minutes per side.', 'Roll the meatballs.') },
      ['vegetarian']
    );
    expect(plant).toEqual([]);
  });
  it('a bare "burgers" step still flags when no ingredient is a plant burger', () => {
    const v = findDietViolations(
      { ingredients: ing('burger buns', 'lettuce'), steps: st('Grill the burgers for 4 minutes per side.') },
      ['vegetarian']
    );
    expect(v).toEqual([{ rule: 'vegetarian', term: 'burgers', where: 'step' }]);
  });
  it('a plant burger ingredient does not hide real meat in steps', () => {
    const v = findDietViolations(
      { ingredients: ing('veggie burgers'), steps: st('Top the burgers with bacon.') },
      ['vegetarian']
    );
    expect(v[0]).toMatchObject({ term: 'bacon', where: 'step' });
  });
  it('a plant burger ingredient does not excuse a meat burger ingredient', () => {
    const v = findDietViolations(
      { ingredients: ing('black bean burger', 'beef burger'), steps: st('Grill the burgers for 4 minutes per side.') },
      ['vegetarian']
    );
    expect(v).toContainEqual({ rule: 'vegetarian', term: 'beef', where: 'ingredient' });
  });
});

describe('review fixes: beer, hoisin, pesto, bone broth (S3)', () => {
  const flagged: Array<[DietRule, string, string]> = [
    ['gluten_free', 'beer', 'beer'],
    ['gluten_free', '1 bottle lager', 'lager'],
    ['gluten_free', 'stout', 'stout'],
    ['gluten_free', 'malt vinegar', 'malt'],
    ['gluten_free', 'hoisin sauce', 'hoisin'],
    ['dairy_free', 'basil pesto', 'pesto'],
    ['vegan', 'pesto', 'pesto'],
    ['nut_free', 'basil pesto', 'pesto'],
    ['nut_free', 'dairy-free pesto', 'pesto'],
    ['vegetarian', 'bone broth', 'bone broth'],
    ['vegan', 'bone broth', 'bone broth'],
    ['pescatarian', 'bone broth', 'bone broth'],
    ['no_beef', 'beef bone broth', 'beef'],
    ['no_poultry', 'chicken bone broth', 'chicken'],
    ['no_pork', 'pork bone broth', 'pork'],
  ];
  it.each(flagged)('%s flags %s', (rule, text, term) => {
    expect(findForbiddenTerm(text, rule)).toBe(term);
  });
  const allowed: Array<[DietRule, string]> = [
    ['gluten_free', 'gluten-free beer'],
    ['gluten_free', 'gluten-free hoisin sauce'],
    ['gluten_free', 'root beer'],
    ['gluten_free', 'ginger beer'],
    ['vegan', 'vegan pesto'],
    ['dairy_free', 'dairy-free pesto'],
    ['dairy_free', 'vegan pesto'],
    ['nut_free', 'nut-free pesto'],
    ['nut_free', 'nut-free basil pesto'],
    ['vegetarian', 'pesto'],
    ['vegetarian', 'vegetable broth'],
    ['no_beef', 'bone broth'],
  ];
  it.each(allowed)('%s allows %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).toBeNull();
  });
});

describe('review fixes: negated needs (N3)', () => {
  it('does not read "not vegetarian" or "non-vegan" as the need', () => {
    expect(parseDietRules(['not vegetarian'])).toEqual([]);
    expect(parseDietRules(['non-vegetarian'])).toEqual([]);
    expect(parseDietRules(['non vegan'])).toEqual([]);
    expect(parseDietRules(['nonvegetarian'])).toEqual([]);
    expect(parseDietRules(["I'm not a vegetarian"])).toEqual([]);
    expect(parseDietRules(["isn't vegan"])).toEqual([]);
  });
  it('still reads the plain need and keeps other needs in the same entry', () => {
    expect(parseDietRules(['vegetarian'])).toEqual(['vegetarian']);
    expect(parseDietRules(['not vegan, but vegetarian'])).toEqual(['vegetarian']);
    expect(parseDietRules(['non-vegetarian, gluten-free'])).toEqual(['gluten_free']);
    expect(parseDietRules(['non-dairy'])).toEqual(['dairy_free']);
  });
});

describe('review fixes: plant and tool names (N4)', () => {
  const allowed: Array<[DietRule, string]> = [
    ['vegan', 'Spread with a butter knife.'],
    ['dairy_free', 'butter knife'],
    ['vegetarian', 'beef tomato'],
    ['no_beef', 'beefsteak tomatoes'],
    ['vegetarian', 'chicken of the woods'],
    ['no_poultry', 'chicken of the woods'],
    ['no_shellfish', 'crab apples'],
    ['no_pork', 'beef gelatin'],
    ['no_pork', 'vegan gelatin'],
  ];
  it.each(allowed)('%s allows %s', (rule, text) => {
    expect(findForbiddenTerm(text, rule)).toBeNull();
  });
  const flagged: Array<[DietRule, string, string]> = [
    ['no_pork', 'gelatin', 'gelatin'],
    ['no_pork', 'unflavored gelatine', 'gelatine'],
    ['vegan', 'butter and a knife', 'butter'],
    ['vegetarian', 'beef and tomato stew', 'beef'],
  ];
  it.each(flagged)('%s flags %s', (rule, text, term) => {
    expect(findForbiddenTerm(text, rule)).toBe(term);
  });
});
