import { BadgesSchema, CheckInHistorySchema, CheckInInputSchema, MasteryRevealResponseSchema, MasteryStartResponseSchema, parseStoredDishPhoto, RecipeBookSchema, RecipeStepSchema } from './schemas';

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
        kind: 'path',
        generated_recipe_id: null,
        last_cooked_at: '2026-11-11T12:00:00.000Z',
        last_difficulty_rating: 'easy',
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
        kind: 'path',
        generated_recipe_id: null,
        last_cooked_at: null,
        last_difficulty_rating: null,
      },
    ];
    expect(RecipeBookSchema.parse(rows)).toEqual(rows);
  });

  it('parses a Cook anything row with null slot fields', () => {
    const row = {
      slot_id: null,
      slot_order: null,
      dish_name: 'pad thai',
      user_recipe_id: null,
      recipe_title: 'Weeknight Pad Thai',
      label: 'completed',
      added_at: '2026-11-10T12:00:00.000Z',
      times_cooked: 3,
      kind: 'cook_anything',
      generated_recipe_id: '10000000-0000-4000-8000-000000000001',
      last_cooked_at: '2026-11-12T12:00:00.000Z',
      last_difficulty_rating: 'hard',
    };
    expect(RecipeBookSchema.parse([row])).toEqual([row]);
  });

  it('still parses the old row shape (database without the new migration) as a path entry', () => {
    const [row] = RecipeBookSchema.parse([
      { slot_id: 1, slot_order: 1, dish_name: 'Salad', user_recipe_id: null, recipe_title: 'Salad', label: 'completed', added_at: null, times_cooked: 1 },
    ]);
    expect(row).toMatchObject({ kind: 'path', generated_recipe_id: null, last_cooked_at: null, last_difficulty_rating: null });
  });

  it('rejects a path row without a slot_id and a Cook anything row without a recipe id', () => {
    const base = { dish_name: 'x', user_recipe_id: null, recipe_title: 'x', label: 'completed', added_at: null, times_cooked: 1 };
    expect(() => RecipeBookSchema.parse([{ ...base, slot_id: null, slot_order: null, kind: 'path' }])).toThrow();
    expect(() => RecipeBookSchema.parse([{ ...base, slot_id: null, slot_order: null, kind: 'cook_anything', generated_recipe_id: null }])).toThrow();
  });

  it('parses check-in history rows', () => {
    const rows = [{ id: 'abc', difficulty_rating: 'ok', went_well: null, was_hard: 'timing', created_at: '2026-11-12T12:00:00.000Z' }];
    expect(CheckInHistorySchema.parse(rows)).toEqual(rows);
    expect(() => CheckInHistorySchema.parse([{ ...rows[0], difficulty_rating: 'meh' }])).toThrow();
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

const pathCheckIn = {
  user_recipe_id: '00000000-0000-4000-8000-000000000010',
  slot_id: 10,
  rating: 'ok' as const,
};

describe('check-in mastery session', () => {
  const sessionId = '20000000-0000-4000-8000-000000000001';

  it('accepts a mastery_session_id', () => {
    const body = { ...pathCheckIn, mastery_session_id: sessionId };
    expect(CheckInInputSchema.parse(body)).toEqual(body);
  });

  it('rejects a non-UUID session id', () => {
    expect(() => CheckInInputSchema.parse({ ...pathCheckIn, mastery_session_id: 'abc' })).toThrow();
  });

  it('never sends client-reported counts', () => {
    const parsed = CheckInInputSchema.parse({ ...pathCheckIn, mastery: { hidden_steps: 3, revealed_steps: 0 } });
    expect(parsed).not.toHaveProperty('mastery');
  });

  it('still accepts a path check-in without a session', () => {
    expect(CheckInInputSchema.parse(pathCheckIn).mastery_session_id).toBeUndefined();
  });
});

describe('mastery responses', () => {
  it('parses a start response and a masked step', () => {
    const start = MasteryStartResponseSchema.parse({
      session_id: '20000000-0000-4000-8000-000000000001',
      hidden_step_indices: [2, 3],
      revealed_steps: { '3': { instruction: 'Rest it', isSafetyStep: false } },
    });
    expect(start.revealed_steps['3'].instruction).toBe('Rest it');
    expect(RecipeStepSchema.parse({ instruction: 'Hidden step.', isSafetyStep: false, isHidden: true }).isHidden).toBe(true);
  });

  it('parses a reveal response', () => {
    const r = MasteryRevealResponseSchema.parse({
      step_index: 2,
      step: { instruction: 'Pat dry', isSafetyStep: false },
      hidden_step_indices: [2, 3],
      revealed_step_indices: [2],
    });
    expect(r.step.instruction).toBe('Pat dry');
  });
});

describe('parseStoredDishPhoto', () => {
  it('returns a valid photo and falls back to null on a bad stored value', () => {
    const photo = {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
      credit: {
        author: 'Jane Cook',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
      },
    };
    expect(parseStoredDishPhoto(photo)).toEqual(photo);
    expect(parseStoredDishPhoto(null)).toBeNull();
    expect(parseStoredDishPhoto({ url: 'not-a-photo' })).toBeNull();
  });
});
