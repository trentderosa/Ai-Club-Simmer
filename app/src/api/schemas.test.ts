import { BadgesSchema, RecipeBookSchema } from './schemas';

describe('recipe book and badge schemas', () => {
  it('parses a get_my_recipe_book row, including a null user_recipe_id', () => {
    const rows = [
      {
        slot_id: 2,
        slot_order: 2,
        dish_name: 'Scrambled Eggs',
        user_recipe_id: '00000000-0000-4000-8000-000000000002',
        recipe_title: 'Soft, Low-and-Slow Scrambled Eggs',
        label: 'completed',
        added_at: '2026-11-10T12:00:00.000Z',
        times_cooked: 2,
      },
      {
        slot_id: 10,
        slot_order: 10,
        dish_name: 'Roast Chicken',
        user_recipe_id: null,
        recipe_title: 'Roast Chicken',
        label: 'mastered',
        added_at: null,
        times_cooked: 1,
      },
    ];
    expect(RecipeBookSchema.parse(rows)).toEqual(rows);
  });

  it('rejects an unknown book label', () => {
    expect(() =>
      RecipeBookSchema.parse([
        {
          slot_id: 1,
          slot_order: 1,
          dish_name: 'Salad',
          user_recipe_id: null,
          recipe_title: 'Salad',
          label: 'favorite',
          added_at: null,
          times_cooked: 1,
        },
      ]),
    ).toThrow();
  });

  it('parses get_my_badges, including the unearned path milestone with a null slot_id', () => {
    const rows = [
      {
        code: 'complete_slot_1',
        name: 'Knife Basics Salad',
        description: 'Cooked Knife Basics Salad and checked in.',
        kind: 'completion',
        slot_id: 1,
        sort_order: 1,
        earned: true,
        earned_at: '2026-11-08T12:00:00.000Z',
      },
      {
        code: 'path_weeknight_basics',
        name: 'Weeknight Basics Graduate',
        description: 'Finished all 10 recipes on the Weeknight basics path.',
        kind: 'path_milestone',
        slot_id: null,
        sort_order: 100,
        earned: false,
        earned_at: null,
      },
    ];
    expect(BadgesSchema.parse(rows)).toEqual(rows);
  });
});
