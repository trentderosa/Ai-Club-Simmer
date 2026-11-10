import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * XP Formula Tests
 *
 * Tests for the team's final XP formula:
 *   XP = max(1, round((steps*0.45 + ingredients*0.35 + cook_minutes*0.2) * 10))
 *
 * Key requirements tested:
 * 1. XP is computed correctly from steps, ingredients, cook_minutes
 * 2. xp_value is a STORED value, not recalculated at award time
 * 3. Changing weights does NOT alter already-awarded xp_events
 * 4. Repeat rule (50%) still works with new formula
 * 5. Weekly cap (100 XP) still works with new formula
 *
 * Note: The formula uses NUMERIC types, and PostgreSQL ROUND(numeric) rounds
 * half away from zero (52.5 → 53, -52.5 → -53), matching JavaScript Math.round
 * for positive numbers. Tests read the actual database values to be authoritative.
 */
describe('XP Formula (weighted inputs)', () => {
  let db: TestDatabase;
  let testUser: TestUser;

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    await db.dropAllTables();
    // N6: Use shared helper that runs all migrations in sorted order
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

    testUser = await db.createTestUser(`test-${Date.now()}@example.com`);
    await db.createProfile(testUser.id);
  });

  describe('XP calculation with formula', () => {
    /**
     * Slot 1: Knife Basics Salad
     * steps=4, ingredients=5, cook_minutes=10
     * XP = max(1, round((4*0.45 + 5*0.35 + 10*0.2) * 10))
     *    = max(1, round((1.8 + 1.75 + 2.0) * 10))
     *    = max(1, round(55.5))
     *    = max(1, 56)
     *    = 56
     */
    it('computes XP correctly for slot 1 (Knife Basics Salad)', async () => {
      const slot = await db.getSlotDetails(1);

      expect(slot.steps).toBe(4);
      expect(slot.ingredients).toBe(5);
      expect(slot.cook_minutes).toBe(10);

      // Formula: max(1, round((4*0.45 + 5*0.35 + 10*0.2) * 10)) = 56
      const expectedXp = Math.max(1, Math.round((4 * 0.45 + 5 * 0.35 + 10 * 0.2) * 10));
      expect(expectedXp).toBe(56);
      expect(slot.xp_value).toBe(56);
    });

    /**
     * Slot 2: Scrambled Eggs
     * steps=5, ingredients=4, cook_minutes=8
     * XP = max(1, round((5*0.45 + 4*0.35 + 8*0.2) * 10))
     *    = max(1, round((2.25 + 1.4 + 1.6) * 10))
     *    = max(1, round(52.5))
     *    = max(1, 53)
     *    = 53
     */
    it('computes XP correctly for slot 2 (Scrambled Eggs)', async () => {
      const slot = await db.getSlotDetails(2);

      expect(slot.steps).toBe(5);
      expect(slot.ingredients).toBe(4);
      expect(slot.cook_minutes).toBe(8);

      // Formula: max(1, round((5*0.45 + 4*0.35 + 8*0.2) * 10)) = 53
      const expectedXp = Math.max(1, Math.round((5 * 0.45 + 4 * 0.35 + 8 * 0.2) * 10));
      expect(expectedXp).toBe(53);
      expect(slot.xp_value).toBe(53);
    });

    /**
     * Slot 3: Pasta with Sauce
     * steps=6, ingredients=6, cook_minutes=20
     * XP = max(1, round((6*0.45 + 6*0.35 + 20*0.2) * 10))
     *    = max(1, round((2.7 + 2.1 + 4.0) * 10))
     *    = max(1, round(88.0))
     *    = max(1, 88)
     *    = 88
     */
    it('computes XP correctly for slot 3 (Pasta with Sauce)', async () => {
      const slot = await db.getSlotDetails(3);

      expect(slot.steps).toBe(6);
      expect(slot.ingredients).toBe(6);
      expect(slot.cook_minutes).toBe(20);

      // Formula: max(1, round((6*0.45 + 6*0.35 + 20*0.2) * 10)) = 88
      const expectedXp = Math.max(1, Math.round((6 * 0.45 + 6 * 0.35 + 20 * 0.2) * 10));
      expect(expectedXp).toBe(88);
      expect(slot.xp_value).toBe(88);
    });
  });

  describe('xp_value is stored (not recalculated at award time)', () => {
    it('awards the stored xp_value, not a dynamic calculation', async () => {
      const slotId = await db.getSlotId(1);
      const slot = await db.getSlotDetails(1);

      const userRecipeId = await db.createUserRecipe(testUser.id, slotId);
      const checkInId = await db.createCheckIn(testUser.id, userRecipeId, slotId);
      const result = await db.awardSlotXp(checkInId);

      expect(result.out_xp_awarded).toBe(slot.xp_value);
      expect(result.out_is_first_completion).toBe(true);
    });

    it('xp_value persists as stored value in path_slots', async () => {
      const slotBefore = await db.getSlotDetails(1);
      const storedXp = slotBefore.xp_value;

      // Verify the stored value matches expected formula
      expect(storedXp).toBe(56);

      // Read it again to confirm it's stored, not computed on read
      const slotAfter = await db.getSlotDetails(1);
      expect(slotAfter.xp_value).toBe(storedXp);
    });
  });

  describe('changing weights does NOT alter already-awarded xp_events', () => {
    it('preserves xp_awarded in xp_events when weights change', async () => {
      const slotId = await db.getSlotId(1);
      const originalSlot = await db.getSlotDetails(1);
      const originalXp = originalSlot.xp_value;

      // Award XP with original formula
      const userRecipeId = await db.createUserRecipe(testUser.id, slotId);
      const checkInId = await db.createCheckIn(testUser.id, userRecipeId, slotId);
      const awardResult = await db.awardSlotXp(checkInId);

      expect(awardResult.out_xp_awarded).toBe(originalXp);

      // Change the weights dramatically
      await db.setXpConfig('steps_weight', 1.0);
      await db.setXpConfig('ingredients_weight', 1.0);
      await db.setXpConfig('cook_minutes_weight', 1.0);

      // The xp_events record should still have the original XP
      const xpEvent = await db.getXpEventDetails(checkInId);
      expect(xpEvent).not.toBeNull();
      expect(xpEvent!.xp_awarded).toBe(originalXp);

      // But path_slots.xp_value should have been recomputed
      const newSlot = await db.getSlotDetails(1);
      // New formula: max(1, round((4*1 + 5*1 + 10*1) * 10)) = max(1, round(190)) = 190
      expect(newSlot.xp_value).toBe(190);
      expect(newSlot.xp_value).not.toBe(originalXp);

      // User's total XP should still reflect the original award
      const totalXp = await db.getUserTotalXp(testUser.id);
      expect(totalXp).toBe(originalXp);
    });
  });

  describe('anti-farming rules still work with new formula', () => {
    it('repeats still earn 50% of stored xp_value', async () => {
      const slotId = await db.getSlotId(1);
      const slot = await db.getSlotDetails(1);
      const userRecipeId = await db.createUserRecipe(testUser.id, slotId);

      // First completion: full XP
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId, slotId);
      const result1 = await db.awardSlotXp(checkIn1);
      expect(result1.out_xp_awarded).toBe(slot.xp_value);
      expect(result1.out_is_first_completion).toBe(true);

      // Repeat: 50% of stored xp_value
      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId, slotId);
      const result2 = await db.awardSlotXp(checkIn2);
      expect(result2.out_xp_awarded).toBe(Math.floor(slot.xp_value * 0.5));
      expect(result2.out_is_first_completion).toBe(false);
    });

    it('weekly repeat cap (100 XP) still enforced', async () => {
      const slotId = await db.getSlotId(3); // Slot 3 has XP=88, 50%=44
      const userRecipeId = await db.createUserRecipe(testUser.id, slotId);

      // First completion: full 88 XP
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId, slotId);
      await db.awardSlotXp(checkIn1);

      let totalRepeatXp = 0;
      let reachedCap = false;

      // Keep repeating until we hit the cap
      for (let i = 0; i < 10; i++) {
        const checkIn = await db.createCheckIn(testUser.id, userRecipeId, slotId);
        const result = await db.awardSlotXp(checkIn);
        totalRepeatXp += result.out_xp_awarded;

        if (result.out_capped && result.out_xp_awarded === 0) {
          reachedCap = true;
          break;
        }
      }

      expect(reachedCap).toBe(true);
      expect(totalRepeatXp).toBeLessThanOrEqual(100);
    });
  });

  describe('trigger recomputes xp_value when inputs change', () => {
    it('updates xp_value when steps/ingredients/cook_minutes change', async () => {
      const slotId = await db.getSlotId(1);
      const originalSlot = await db.getSlotDetails(1);

      // Original: steps=4, ingredients=5, cook_minutes=10, XP=56
      expect(originalSlot.xp_value).toBe(56);

      // Update inputs: steps=10, ingredients=10, cook_minutes=30
      await db.updateSlotInputs(slotId, 10, 10, 30);

      // New XP = max(1, round((10*0.45 + 10*0.35 + 30*0.2) * 10))
      //        = max(1, round((4.5 + 3.5 + 6) * 10))
      //        = max(1, round(140))
      //        = 140
      const newSlot = await db.getSlotDetails(1);
      expect(newSlot.xp_value).toBe(140);
    });
  });

  describe('minimum XP is 1', () => {
    it('returns at least 1 XP even with very low inputs', async () => {
      const slotId = await db.getSlotId(1);

      // Set very low inputs that would compute to < 1
      // steps=0, ingredients=0, cook_minutes=0 → XP = max(1, round(0)) = 1
      await db.updateSlotInputs(slotId, 0, 0, 0);

      const slot = await db.getSlotDetails(1);
      expect(slot.xp_value).toBe(1);
    });
  });

  describe('config weights are stored as NUMERIC', () => {
    it('stores decimal weights correctly', async () => {
      const stepsWeight = await db.getXpConfigValue('steps_weight');
      const ingredientsWeight = await db.getXpConfigValue('ingredients_weight');
      const cookMinutesWeight = await db.getXpConfigValue('cook_minutes_weight');
      const multiplier = await db.getXpConfigValue('xp_multiplier');

      expect(stepsWeight).toBe(0.45);
      expect(ingredientsWeight).toBe(0.35);
      expect(cookMinutesWeight).toBe(0.2);
      expect(multiplier).toBe(10);
    });
  });

  describe('security: recompute_slot_xp access control (S1)', () => {
    it('client cannot call recompute_slot_xp directly', async () => {
      const result = await db.tryClientCallRecomputeSlotXpAsRole();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission|denied/i);
    });
  });

  describe('config bounds enforcement (N7)', () => {
    it('rejects weight values above upper bound', async () => {
      // N7: Test that the xp_config_weight_bounds CHECK constraint is enforced
      // Weights (steps, ingredients, cook_minutes) have max 10
      const result = await db.tryUpdateXpConfigValue('steps_weight', 11);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/check|constraint|violates/i);
    });

    it('rejects multiplier values above upper bound', async () => {
      // xp_multiplier has max 1000
      const result = await db.tryUpdateXpConfigValue('xp_multiplier', 1001);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/check|constraint|violates/i);
    });

    it('accepts weight values within bounds', async () => {
      const result = await db.tryUpdateXpConfigValue('steps_weight', 5);

      expect(result.success).toBe(true);
    });
  });
});
