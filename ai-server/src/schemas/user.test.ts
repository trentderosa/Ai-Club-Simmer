import { describe, expect, it } from 'vitest';
import {
  BudgetLevelSchema,
  CheckInSchema,
  DietaryNeedsSchema,
  ExperienceLevelSchema,
  UserProfileSchema,
} from './user.js';

const str = (n: number): string => 'a'.repeat(n);
const VALID_UUID = '123e4567-e89b-42d3-a456-426614174000';

function checkIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { recipeName: 'Fake Pasta', difficulty: 'easy', ...overrides };
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_UUID,
    experienceLevel: 'never_cooked',
    budget: 'low',
    equipment: ['pan'],
    ...overrides,
  };
}

describe('ExperienceLevelSchema', () => {
  it.each(['never_cooked', 'a_little', 'comfortable'])('accepts %s', (v) => {
    expect(ExperienceLevelSchema.safeParse(v).success).toBe(true);
  });

  it.each(['expert', '', 'Never_Cooked', 1, null, undefined])('rejects %s', (v) => {
    expect(ExperienceLevelSchema.safeParse(v).success).toBe(false);
  });
});

describe('BudgetLevelSchema', () => {
  it.each(['low', 'medium', 'high'])('accepts %s', (v) => {
    expect(BudgetLevelSchema.safeParse(v).success).toBe(true);
  });

  it.each(['mid', '', 'LOW', 1, null, undefined])('rejects %s', (v) => {
    expect(BudgetLevelSchema.safeParse(v).success).toBe(false);
  });
});

describe('DietaryNeedsSchema', () => {
  it('accepts an empty array', () => {
    expect(DietaryNeedsSchema.safeParse([]).success).toBe(true);
  });

  it('enforces item length 1..100', () => {
    expect(DietaryNeedsSchema.safeParse(['']).success).toBe(false);
    expect(DietaryNeedsSchema.safeParse([str(1)]).success).toBe(true);
    expect(DietaryNeedsSchema.safeParse([str(100)]).success).toBe(true);
    expect(DietaryNeedsSchema.safeParse([str(101)]).success).toBe(false);
  });

  it('enforces max 20 items', () => {
    expect(DietaryNeedsSchema.safeParse(Array.from({ length: 20 }, () => 'vegan')).success).toBe(
      true
    );
    expect(DietaryNeedsSchema.safeParse(Array.from({ length: 21 }, () => 'vegan')).success).toBe(
      false
    );
  });

  it('rejects non-string items and non-arrays', () => {
    expect(DietaryNeedsSchema.safeParse([1]).success).toBe(false);
    expect(DietaryNeedsSchema.safeParse('vegan').success).toBe(false);
  });
});

describe('CheckInSchema', () => {
  it('accepts a minimal check-in and leaves optional fields absent', () => {
    const result = CheckInSchema.safeParse(checkIn());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(checkIn());
  });

  it('accepts optional fields', () => {
    const full = checkIn({ whatWentWell: 'Tasty', whatWasHard: 'Timing' });
    expect(CheckInSchema.parse(full)).toEqual(full);
  });

  it('rejects missing required fields', () => {
    expect(CheckInSchema.safeParse({ difficulty: 'easy' }).success).toBe(false);
    expect(CheckInSchema.safeParse({ recipeName: 'Fake Pasta' }).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(CheckInSchema.safeParse(checkIn({ recipeName: 1 })).success).toBe(false);
    expect(CheckInSchema.safeParse(checkIn({ whatWentWell: 1 })).success).toBe(false);
    expect(CheckInSchema.safeParse(checkIn({ whatWasHard: 1 })).success).toBe(false);
  });

  it.each(['easy', 'ok', 'hard'])('accepts difficulty %s', (d) => {
    expect(CheckInSchema.safeParse(checkIn({ difficulty: d })).success).toBe(true);
  });

  it.each(['medium', 'OK', '', 3])('rejects difficulty %s', (d) => {
    expect(CheckInSchema.safeParse(checkIn({ difficulty: d })).success).toBe(false);
  });

  it('enforces recipeName length 1..200', () => {
    expect(CheckInSchema.safeParse(checkIn({ recipeName: '' })).success).toBe(false);
    expect(CheckInSchema.safeParse(checkIn({ recipeName: str(1) })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ recipeName: str(200) })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ recipeName: str(201) })).success).toBe(false);
  });

  it('enforces whatWentWell max 1000 and allows empty', () => {
    expect(CheckInSchema.safeParse(checkIn({ whatWentWell: '' })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ whatWentWell: str(1000) })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ whatWentWell: str(1001) })).success).toBe(false);
  });

  it('enforces whatWasHard max 1000 and allows empty', () => {
    expect(CheckInSchema.safeParse(checkIn({ whatWasHard: '' })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ whatWasHard: str(1000) })).success).toBe(true);
    expect(CheckInSchema.safeParse(checkIn({ whatWasHard: str(1001) })).success).toBe(false);
  });
});

describe('UserProfileSchema', () => {
  it('accepts a minimal profile and leaves optional fields absent', () => {
    const result = UserProfileSchema.safeParse(profile());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(profile());
      expect(result.data.dietaryNeeds).toBeUndefined();
      expect(result.data.recentCheckIns).toBeUndefined();
    }
  });

  it('accepts a full profile', () => {
    const full = profile({
      dietaryNeeds: ['vegetarian'],
      recentCheckIns: [checkIn()],
    });
    expect(UserProfileSchema.parse(full)).toEqual(full);
  });

  it.each(['id', 'experienceLevel', 'budget', 'equipment'])('rejects a missing %s', (field) => {
    const input: Record<string, unknown> = profile();
    delete input[field];
    expect(UserProfileSchema.safeParse(input).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(UserProfileSchema.safeParse(profile({ id: 1 })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ equipment: 'pan' })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ dietaryNeeds: 'vegan' })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ recentCheckIns: 'x' })).success).toBe(false);
    expect(UserProfileSchema.safeParse(null).success).toBe(false);
  });

  it('requires id to be a valid UUID', () => {
    expect(UserProfileSchema.safeParse(profile({ id: 'not-a-uuid' })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ id: '' })).success).toBe(false);
    // Right shape but invalid version/variant bits (zod v4 strict uuid).
    expect(
      UserProfileSchema.safeParse(profile({ id: '123e4567-e89b-02d3-a456-426614174000' })).success
    ).toBe(false);
  });

  it('rejects invalid enum values', () => {
    expect(UserProfileSchema.safeParse(profile({ experienceLevel: 'pro' })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ budget: 'free' })).success).toBe(false);
  });

  it('enforces equipment max 50 items', () => {
    const items = (n: number): unknown[] => Array.from({ length: n }, (_, i) => `tool ${i}`);
    expect(UserProfileSchema.safeParse(profile({ equipment: [] })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ equipment: items(50) })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ equipment: items(51) })).success).toBe(false);
  });

  it('enforces equipment item length 1..100', () => {
    expect(UserProfileSchema.safeParse(profile({ equipment: [''] })).success).toBe(false);
    expect(UserProfileSchema.safeParse(profile({ equipment: [str(1)] })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ equipment: [str(100)] })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ equipment: [str(101)] })).success).toBe(false);
  });

  it('enforces dietaryNeeds bounds through the profile', () => {
    expect(
      UserProfileSchema.safeParse(
        profile({ dietaryNeeds: Array.from({ length: 20 }, () => 'x') })
      ).success
    ).toBe(true);
    expect(
      UserProfileSchema.safeParse(
        profile({ dietaryNeeds: Array.from({ length: 21 }, () => 'x') })
      ).success
    ).toBe(false);
  });

  it('enforces recentCheckIns max 10 items', () => {
    const items = (n: number): unknown[] => Array.from({ length: n }, () => checkIn());
    expect(UserProfileSchema.safeParse(profile({ recentCheckIns: [] })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ recentCheckIns: items(10) })).success).toBe(true);
    expect(UserProfileSchema.safeParse(profile({ recentCheckIns: items(11) })).success).toBe(
      false
    );
  });

  it('validates nested check-ins', () => {
    expect(
      UserProfileSchema.safeParse(profile({ recentCheckIns: [checkIn({ difficulty: 'nope' })] }))
        .success
    ).toBe(false);
  });
});
