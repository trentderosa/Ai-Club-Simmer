import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';
import fs from 'fs';
import path from 'path';

describe('XP Award Logic (F7)', () => {
  let db: TestDatabase;
  let testUser: TestUser;
  let testUser2: TestUser;
  let slotId1: number;
  let slotId2: number;
  let slot1XpValue: number;
  let slot2XpValue: number;
  let userRecipeId1: string;
  let userRecipeId2: string;

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();

    await db.dropAllTables();

    const migrationPath = path.join(__dirname, '../..', 'supabase/migrations/20261103000000_core_schema.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.runMigration(migrationSql);
    
    await db.setupRoles();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.cleanupTestData();
    await db.resetXpConfig();

    testUser = await db.createTestUser(`test-${Date.now()}@example.com`);
    testUser2 = await db.createTestUser(`test2-${Date.now()}@example.com`);
    await db.createProfile(testUser.id);
    await db.createProfile(testUser2.id);

    slotId1 = await db.getSlotId(1);
    slotId2 = await db.getSlotId(2);
    slot1XpValue = await db.getSlotXpValue(slotId1);
    slot2XpValue = await db.getSlotXpValue(slotId2);

    userRecipeId1 = await db.createUserRecipe(testUser.id, slotId1);
    userRecipeId2 = await db.createUserRecipe(testUser.id, slotId2);
  });

  describe('First completion', () => {
    it('awards full XP for first completion of a slot', async () => {
      const checkInId = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkInId);

      expect(result.out_xp_awarded).toBe(slot1XpValue);
      expect(result.out_is_first_completion).toBe(true);
      expect(result.out_capped).toBe(false);
    });

    it('awards full XP for first completion of different slots', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result1 = await db.awardSlotXp(checkIn1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId2, slotId2);
      const result2 = await db.awardSlotXp(checkIn2);

      expect(result1.out_xp_awarded).toBe(slot1XpValue);
      expect(result1.out_is_first_completion).toBe(true);

      expect(result2.out_xp_awarded).toBe(slot2XpValue);
      expect(result2.out_is_first_completion).toBe(true);

      const totalXp = await db.getUserTotalXp(testUser.id);
      expect(totalXp).toBe(slot1XpValue + slot2XpValue);
    });
  });

  describe('Repeat completions at 50%', () => {
    it('awards 50% XP for repeat completion of same slot', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkIn2);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.5));
      expect(result.out_is_first_completion).toBe(false);
    });

    it('respects configurable repeat percentage', async () => {
      await db.setXpConfig('repeat_xp_percent', 25);

      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkIn2);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.25));
    });
  });

  describe('Weekly repeat cap', () => {
    it('caps repeat XP at 100 per week', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      let totalRepeatXp = 0;
      let reachedCap = false;

      for (let i = 0; i < 10; i++) {
        const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
        const result = await db.awardSlotXp(checkIn);
        totalRepeatXp += result.out_xp_awarded;

        if (result.out_capped) {
          reachedCap = true;
          break;
        }
      }

      expect(reachedCap).toBe(true);
      expect(totalRepeatXp).toBeLessThanOrEqual(100);
    });

    it('awards 0 XP for repeats after cap is reached', async () => {
      await db.setXpConfig('weekly_repeat_cap', 20);

      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn2);

      const checkIn3 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkIn3);

      expect(result.out_xp_awarded).toBe(0);
      expect(result.out_capped).toBe(true);
      expect(result.out_weekly_repeat_remaining).toBe(0);
    });

    it('resets weekly cap after a week', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      await db.setXpConfig('weekly_repeat_cap', 20);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn2);
      await db.backdateXpEvent(checkIn2, 8);

      const checkIn3 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkIn3);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.5));
      expect(result.out_capped).toBe(false);
    });

    it('handles concurrent repeat awards without exceeding cap (S1 fix)', async () => {
      await db.setXpConfig('weekly_repeat_cap', 40);

      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      const checkIns = await Promise.all([
        db.createCheckIn(testUser.id, userRecipeId1, slotId1),
        db.createCheckIn(testUser.id, userRecipeId1, slotId1),
        db.createCheckIn(testUser.id, userRecipeId1, slotId1),
        db.createCheckIn(testUser.id, userRecipeId1, slotId1),
      ]);

      const results = await Promise.all(
        checkIns.map(id => db.awardSlotXp(id))
      );

      const totalRepeatXp = results.reduce((sum, r) => sum + r.out_xp_awarded, 0);
      expect(totalRepeatXp).toBeLessThanOrEqual(40);
    });
  });

  describe('Security: RLS enforcement (S2 fix)', () => {
    it('client cannot insert into xp_events directly', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      
      const result = await db.tryClientInsertXpEventAsRole(
        testUser.id,
        checkIn,
        slotId1,
        9999
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/policy|permission|denied/i);
    });

    it('client cannot update xp_config (B4 fix)', async () => {
      const result = await db.tryClientUpdateXpConfigAsRole('weekly_repeat_cap', 999999);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission|denied/i);
    });

    it('client cannot insert user_recipes directly (S5 fix)', async () => {
      const slotId3 = await db.getSlotId(3);
      
      const result = await db.tryClientInsertUserRecipeAsRole(testUser.id, slotId3);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/policy|permission|denied/i);
    });

    it('user B cannot award XP for user A check-in (B1 fix)', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);

      await expect(
        db.awardSlotXpAsUser(checkIn, testUser2.id)
      ).rejects.toThrow(/Access denied/);
    });

    it('user can award XP for their own check-in', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      
      const result = await db.awardSlotXpAsUser(checkIn, testUser.id);

      expect(result.out_xp_awarded).toBe(slot1XpValue);
      expect(result.out_is_first_completion).toBe(true);
    });

    it('client cannot create check-in with mismatched slot (B2 fix)', async () => {
      const result = await db.tryClientInsertCheckInAsRole(
        testUser.id,
        userRecipeId1,
        slotId2
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/policy|violates/i);
    });

    it('client can create check-in with matching recipe/slot', async () => {
      const result = await db.tryClientInsertCheckInAsRole(
        testUser.id,
        userRecipeId1,
        slotId1
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Security: award_slot_xp derives user/slot from check-in (B1 fix)', () => {
    it('derives user_id and slot_id from check_in row', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.awardSlotXp(checkIn);

      expect(result.out_xp_awarded).toBe(slot1XpValue);

      const totalXp = await db.getUserTotalXp(testUser.id);
      expect(totalXp).toBe(slot1XpValue);

      const user2TotalXp = await db.getUserTotalXp(testUser2.id);
      expect(user2TotalXp).toBe(0);
    });

    it('rejects invalid check_in_id', async () => {
      const fakeCheckInId = '00000000-0000-0000-0000-000000000000';

      await expect(db.awardSlotXp(fakeCheckInId)).rejects.toThrow(/Invalid or non-existent check_in_id/);
    });
  });

  describe('Security: is_repeat is server-computed', () => {
    it('computes is_repeat from user_slot_completions, ignoring client', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn1);

      const isRepeat1 = await db.getCheckInIsRepeat(checkIn1);
      expect(isRepeat1).toBe(false);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn2);

      const isRepeat2 = await db.getCheckInIsRepeat(checkIn2);
      expect(isRepeat2).toBe(true);
    });

    it('marks slot as completed in user_slot_completions', async () => {
      const isCompletedBefore = await db.isSlotCompleted(testUser.id, slotId1);
      expect(isCompletedBefore).toBe(false);

      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(checkIn);

      const isCompletedAfter = await db.isSlotCompleted(testUser.id, slotId1);
      expect(isCompletedAfter).toBe(true);
    });
  });

  describe('Concurrency - two simultaneous requests', () => {
    it('awards XP exactly once when two requests race on same check-in', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);

      const results = await Promise.allSettled([
        db.awardSlotXp(checkIn),
        db.awardSlotXp(checkIn),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      const eventCount = await db.getXpEventCount(checkIn);
      expect(eventCount).toBe(1);

      const totalXp = await db.getUserTotalXp(testUser.id);
      expect(totalXp).toBe(slot1XpValue);
    });

    it('handles concurrent completions for different check-ins correctly', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);

      const results = await Promise.allSettled([
        db.awardSlotXp(checkIn1),
        db.awardSlotXp(checkIn2),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBe(2);

      const xpEvent1Count = await db.getXpEventCount(checkIn1);
      const xpEvent2Count = await db.getXpEventCount(checkIn2);
      expect(xpEvent1Count + xpEvent2Count).toBe(2);

      const totalXp = await db.getUserTotalXp(testUser.id);
      expect(totalXp).toBe(slot1XpValue + Math.floor(slot1XpValue * 0.5));
    });
  });
});
