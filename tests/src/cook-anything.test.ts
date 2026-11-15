import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * Cook-anything XP and storage.
 *
 * Formula (same as slots, from xp_config):
 *   XP = max(1, round((steps*0.45 + ingredients*0.35 + minutes*0.2) * 10))
 *
 * Clamp bounds (xp_config / FREEFORM_COUNT_BOUNDS): steps 1–10, ingredients 1–12, minutes 1–45.
 * Example: 5 steps, 6 ingredients, 20 minutes → 83.5 → 84 (mock canned recipe).
 * Inflated: 50/80/999 → clamped to 10/12/45 → 177 (below roast chicken, 181).
 */
describe('Cook anything (free-form XP, cache, caps)', () => {
  let db: TestDatabase;
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    await db.dropAllTables();
    await db.runAllMigrations();
    await db.setupRoles();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.cleanupTestData();
    await db.resetXpConfig();
    await db.resetXpWeights();
    user = await db.createTestUser(`test-ca-${Date.now()}@example.com`);
    other = await db.createTestUser(`test-ca2-${Date.now()}@example.com`);
    await db.createProfile(user.id);
    await db.createProfile(other.id);
  });

  describe('formula and clamp constants', () => {
    it('computes the same XP as slots for 5 steps, 6 ingredients, 20 minutes (mock recipe = 84)', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      expect(recipe.xp_value).toBe(84);
      const checkIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const result = await db.awardGeneratedRecipeXp(checkIn);
      expect(result.out_xp_awarded).toBe(84);
      expect(result.out_is_first_completion).toBe(true);
      expect(result.out_capped).toBe(false);
    });

    it('clamps an inflated insert (50 steps, 80 ingredients, 999 minutes) to xp_value 177 and awards 177 (under the 200 daily cap)', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        dishQuery: 'Mega Stew',
        normalizedDishName: 'mega stew',
        stepCount: 50,
        ingredientCount: 80,
        timeEstimateMinutes: 999,
      });
      expect(recipe.step_count).toBe(10);
      expect(recipe.ingredient_count).toBe(12);
      expect(recipe.time_estimate_minutes).toBe(45);
      expect(recipe.xp_value).toBe(177);
      const checkIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const result = await db.awardGeneratedRecipeXp(checkIn);
      // 177 is under the default freeform_daily_cap of 200, so this lone award is not capped.
      expect(result.out_xp_awarded).toBe(177);
      expect(result.out_capped).toBe(false);
      expect(result.out_is_first_completion).toBe(true);
    });
  });

  describe('frozen counts per normalized dish name', () => {
    it('does not raise steps, ingredients, minutes, or xp_value after a reroll updates recipe_json', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      expect(recipe.xp_value).toBe(84);

      await db.tryUpdateGeneratedRecipeCounts(recipe.id, {
        stepCount: 50,
        ingredientCount: 80,
        timeEstimateMinutes: 999,
        xpValue: 999,
        recipeJson: {
          title: 'Rerolled',
          ingredients: Array.from({ length: 80 }, (_, i) => ({ name: `x${i}`, amount: '1' })),
          timeEstimateMinutes: 999,
          steps: Array.from({ length: 50 }, (_, i) => ({ instruction: `S${i}`, isSafetyStep: false })),
        },
      });

      const after = await db.getGeneratedRecipeRow(recipe.id);
      expect(after.step_count).toBe(5);
      expect(after.ingredient_count).toBe(6);
      expect(after.time_estimate_minutes).toBe(20);
      expect(after.xp_value).toBe(84);
      expect((after.recipe_json as { title: string }).title).toBe('Rerolled');

      const checkIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const result = await db.awardGeneratedRecipeXp(checkIn);
      expect(result.out_xp_awarded).toBe(84);
    });
  });

  describe('repeat rule keyed on normalized dish name', () => {
    it('awards 50% XP when the same normalized dish is cooked again', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      const first = await db.createGeneratedCheckIn(user.id, recipe.id);
      await db.awardGeneratedRecipeXp(first);
      const second = await db.createGeneratedCheckIn(user.id, recipe.id);
      const result = await db.awardGeneratedRecipeXp(second);
      expect(result.out_is_first_completion).toBe(false);
      expect(result.out_xp_awarded).toBe(42); // floor(84 * 50 / 100)
      expect(result.out_capped).toBe(false);
    });

    it('is idempotent: a second award for the same check-in does not insert another XP row', async () => {
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
        normalizedDishName: 'pho',
        dishQuery: 'Pho',
      });
      const checkIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const first = await db.awardGeneratedRecipeXp(checkIn);
      expect(first.out_xp_awarded).toBe(84);
      await expect(db.awardGeneratedRecipeXp(checkIn)).rejects.toThrow();
      expect(await db.countGeneratedXpEvents(checkIn)).toBe(1);
    });
  });

  describe('shared daily and weekly caps alongside slot XP', () => {
    it('counts free-form and slot repeat XP toward the same weekly repeat cap', async () => {
      await db.setXpConfig('weekly_repeat_cap', 50);
      const slotId = await db.getSlotId(2); // 62 XP, repeat = 31
      const userRecipeId = await db.createUserRecipe(user.id, slotId);
      const slotFirst = await db.createCheckIn(user.id, userRecipeId, slotId);
      await db.awardSlotXp(slotFirst);
      const slotRepeat = await db.createCheckIn(user.id, userRecipeId, slotId);
      const slotRepeatResult = await db.awardSlotXp(slotRepeat);
      expect(slotRepeatResult.out_xp_awarded).toBe(31);
      expect(slotRepeatResult.out_capped).toBe(false);

      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
        normalizedDishName: 'ramen',
        dishQuery: 'Ramen',
      });
      const genFirst = await db.createGeneratedCheckIn(user.id, recipe.id);
      await db.awardGeneratedRecipeXp(genFirst);
      const genRepeat = await db.createGeneratedCheckIn(user.id, recipe.id);
      const genRepeatResult = await db.awardGeneratedRecipeXp(genRepeat);
      // Usual repeat is 42, but only 19 remains of the shared 50 weekly cap (50-31).
      expect(genRepeatResult.out_xp_awarded).toBe(19);
      expect(genRepeatResult.out_capped).toBe(true);
    });

    it('counts today\'s slot XP toward the daily cap when awarding free-form XP', async () => {
      await db.setXpConfig('freeform_daily_cap', 100);
      const slotId = await db.getSlotId(2); // 62 first-completion XP
      const userRecipeId = await db.createUserRecipe(user.id, slotId);
      const slotCheckIn = await db.createCheckIn(user.id, userRecipeId, slotId);
      const slotResult = await db.awardSlotXp(slotCheckIn);
      expect(slotResult.out_xp_awarded).toBe(62);

      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
        normalizedDishName: 'udon',
        dishQuery: 'Udon',
      });
      const genCheckIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const genResult = await db.awardGeneratedRecipeXp(genCheckIn);
      // Usual first award is 84, but only 38 remains of the 100 daily cap (100-62).
      expect(genResult.out_xp_awarded).toBe(38);
      expect(genResult.out_capped).toBe(true);
    });

    it('includes free-form XP in get_user_total_xp and plan summary totals', async () => {
      const slotId = await db.getSlotId(2);
      const userRecipeId = await db.createUserRecipe(user.id, slotId);
      const slotCheckIn = await db.createCheckIn(user.id, userRecipeId, slotId);
      await db.awardSlotXp(slotCheckIn);
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      const genCheckIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      await db.awardGeneratedRecipeXp(genCheckIn);
      expect(await db.getUserTotalXp(user.id)).toBe(62 + 84);
      expect(await db.getUserTotalXpViaFunction(user.id)).toBe(62 + 84);
    });
  });

  describe('RLS and grants', () => {
    it('lets a user read only their own generated recipe', async () => {
      const mine = await db.createGeneratedRecipe(user.id, {
        stepCount: 4,
        ingredientCount: 4,
        timeEstimateMinutes: 15,
      });
      await db.createGeneratedRecipe(other.id, {
        stepCount: 4,
        ingredientCount: 4,
        timeEstimateMinutes: 15,
        normalizedDishName: 'other dish',
        dishQuery: 'Other Dish',
      });
      expect(await db.listGeneratedRecipeIdsAsUser(user.id)).toEqual([mine.id]);
    });

    it('rejects client inserts into user_generated_recipes and generated_recipe_xp_events', async () => {
      const result = await db.tryInsertGeneratedRecipeAsUser(user.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('denies award_generated_recipe_xp to anon and authenticated, allows service_role', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'award_generated_recipe_xp(uuid)')).toBe(false);
      expect(await db.hasFunctionPrivilege('authenticated', 'award_generated_recipe_xp(uuid)')).toBe(
        false
      );
      expect(await db.hasFunctionPrivilege('service_role', 'award_generated_recipe_xp(uuid)')).toBe(
        true
      );
      const recipe = await db.createGeneratedRecipe(user.id, {
        stepCount: 5,
        ingredientCount: 6,
        timeEstimateMinutes: 20,
      });
      const checkIn = await db.createGeneratedCheckIn(user.id, recipe.id);
      const asUser = await db.tryAwardGeneratedRecipeXpAsRole(checkIn, 'authenticated', user.id);
      expect(asUser.success).toBe(false);
      expect(asUser.error).toMatch(/permission denied/i);
    });
  });
});
