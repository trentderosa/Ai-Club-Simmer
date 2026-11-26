import {
  CUISINE_OPTIONS,
  DIETARY_OPTIONS,
  MEAL_TYPE_OPTIONS,
  formatChoiceList,
  toggleDietary,
  experienceCaption,
  formatCookingSince,
  formatEquipmentList,
  formatSchedule,
  initialFromName,
  joinGoals,
  parseGoals,
  profileSubtitle,
} from './profile-copy';

describe('profile copy', () => {
  it('round-trips goals the way onboarding stores them', () => {
    const goals = ['Cook 3 dinners a week', 'Spend less on takeout'];
    expect(parseGoals(joinGoals(goals))).toEqual(goals);
    expect(parseGoals(null)).toEqual([]);
    expect(parseGoals('  Eat healthier ;  Meal prep ')).toEqual(['Eat healthier', 'Meal prep']);
  });

  it('describes experience without inventing L1–L4 cooking levels', () => {
    expect(experienceCaption('never_cooked')).toBe('New to cooking');
    expect(experienceCaption('a_little')).toBe('A little experience');
    expect(experienceCaption('comfortable')).toBe('Comfortable in the kitchen');
    expect(experienceCaption(null)).toBeNull();
  });

  it('formats the profile subtitle from created_at and experience', () => {
    expect(formatCookingSince('2026-11-02T12:00:00.000Z')).toBe('Cooking since Nov 2');
    expect(profileSubtitle({ created_at: '2026-11-02T12:00:00.000Z', experience_level: 'a_little' })).toBe(
      'Cooking since Nov 2 · A little experience',
    );
    expect(profileSubtitle({ created_at: null, experience_level: 'a_little' })).toBe('A little experience');
  });

  it('formats equipment, schedule and the avatar initial', () => {
    expect(formatEquipmentList(['stove', 'cutting board'])).toBe('Stove, Cutting board');
    expect(formatSchedule(3, 30)).toBe('3 days a week · 30 min');
    expect(formatSchedule(1, 15)).toBe('1 day a week · 15 min');
    expect(initialFromName('Jordan')).toBe('J');
    expect(initialFromName('  ')).toBe('?');
  });
});

describe('taste answers', () => {
  it('stores the fixed lowercase values', () => {
    expect(CUISINE_OPTIONS.map((o) => o.value)).toEqual(['mexican', 'italian', 'chinese', 'japanese', 'korean', 'thai', 'indian', 'mediterranean', 'middle_eastern', 'american']);
    expect(MEAL_TYPE_OPTIONS.map((o) => o.value)).toEqual(['quick_weeknight', 'meal_prep', 'breakfast', 'date_night', 'comfort']);
    expect(DIETARY_OPTIONS).toHaveLength(13);
    expect(DIETARY_OPTIONS.find((o) => o.value === 'nut_free')?.label).toBe('Nut allergy');
  });

  it('makes vegan imply vegetarian, and dropping vegetarian drops vegan', () => {
    expect(toggleDietary([], 'vegan')).toEqual(['vegan', 'vegetarian']);
    expect(toggleDietary(['vegetarian'], 'vegan')).toEqual(['vegetarian', 'vegan']);
    expect(toggleDietary(['vegan', 'vegetarian', 'no_pork'], 'vegetarian')).toEqual(['no_pork']);
    expect(toggleDietary(['vegan', 'vegetarian'], 'vegan')).toEqual(['vegetarian']);
  });

  it('formats answers for the profile and skips empty or unknown values', () => {
    expect(formatChoiceList(['middle_eastern', 'thai'], CUISINE_OPTIONS)).toBe('Thai, Middle Eastern');
    expect(formatChoiceList([], CUISINE_OPTIONS)).toBeNull();
    expect(formatChoiceList(undefined, CUISINE_OPTIONS)).toBeNull();
    expect(formatChoiceList(['klingon'], CUISINE_OPTIONS)).toBeNull();
  });
});
