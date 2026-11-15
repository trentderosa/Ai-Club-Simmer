import { highlightIngredients, ingredientTerms } from './highlight';

const ingredients = [
  { amount: '1 small head', name: 'broccoli, cut into florets' },
  { amount: '1', name: 'red bell pepper, sliced' },
  { amount: '1', name: 'carrot, thinly sliced' },
  { amount: '3 tbsp', name: 'soy sauce' },
];

describe('highlightIngredients', () => {
  it('derives full names and head nouns', () => {
    expect(ingredientTerms(ingredients)).toEqual(expect.arrayContaining(['red bell pepper', 'pepper', 'broccoli', 'soy sauce', 'sauce']));
  });

  it('marks ingredient words, including plurals', () => {
    const runs = highlightIngredients('Add the carrots and broccoli, then the soy sauce.', ingredients);
    expect(runs.filter((r) => r.highlight).map((r) => r.text)).toEqual(['carrots', 'broccoli', 'soy sauce']);
    expect(runs.map((r) => r.text).join('')).toBe('Add the carrots and broccoli, then the soy sauce.');
  });

  it('leaves text without ingredients alone', () => {
    expect(highlightIngredients('Heat the pan.', ingredients)).toEqual([{ text: 'Heat the pan.', highlight: false }]);
  });
});
