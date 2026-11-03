import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';
import fs from 'fs';
import path from 'path';

describe('XP Award Logic (F7)', () => {
  let db: TestDatabase;
  let testUser: TestUser;
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
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.cleanupTestData();
    await db.resetXpConfig();

    testUser = await db.createTestUser(`test-${Date.now()}@example.com`);
    await db.createProfile(testUser.id);

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
      const result = await db.awardSlotXp(testUser.id, checkInId, slotId1);

      expect(result.out_xp_awarded).toBe(slot1XpValue);
      expect(result.out_is_first_completion).toBe(true);
      expect(result.out_capped).toBe(false);
    });

    it('awards full XP for first completion of different slots', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result1 = await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId2, slotId2);
      const result2 = await db.awardSlotXp(testUser.id, checkIn2, slotId2);

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
      await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      const result = await db.awardSlotXp(testUser.id, checkIn2, slotId1);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.5));
      expect(result.out_is_first_completion).toBe(false);
    });

    it('respects configurable repeat percentage', async () => {
      await db.setXpConfig('repeat_xp_percent', 25);

      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      const result = await db.awardSlotXp(testUser.id, checkIn2, slotId1);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.25));
    });
  });

  describe('Weekly repeat cap', () => {
    it('caps repeat XP at 100 per week', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      let totalRepeatXp = 0;
      let reachedCap = false;

      for (let i = 0; i < 10; i++) {
        const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
        const result = await db.awardSlotXp(testUser.id, checkIn, slotId1);
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
      await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      await db.awardSlotXp(testUser.id, checkIn2, slotId1);

      const checkIn3 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      const result = await db.awardSlotXp(testUser.id, checkIn3, slotId1);

      expect(result.out_xp_awarded).toBe(0);
      expect(result.out_capped).toBe(true);
      expect(result.out_weekly_repeat_remaining).toBe(0);
    });

    it('resets weekly cap after a week', async () => {
      const checkIn1 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      await db.awardSlotXp(testUser.id, checkIn1, slotId1);

      await db.setXpConfig('weekly_repeat_cap', 20);

      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      await db.awardSlotXp(testUser.id, checkIn2, slotId1);
      await db.backdateXpEvent(checkIn2, 8);

      const checkIn3 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);
      const result = await db.awardSlotXp(testUser.id, checkIn3, slotId1);

      expect(result.out_xp_awarded).toBe(Math.floor(slot1XpValue * 0.5));
      expect(result.out_capped).toBe(false);
    });
  });

  describe('Client cannot set XP amounts (RLS enforced in production)', () => {
    it('validates xp_events table has no INSERT policy for clients', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);

      const inserted = await db.tryClientInsertXpEvent(
        testUser.id,
        checkIn,
        slotId1,
        9999
      );

      expect(inserted).toBe(true);

      const hasInsertPolicy = await db.hasClientInsertPolicy('xp_events');
      expect(hasInsertPolicy).toBe(false);
    });
  });

  describe('Concurrency - two simultaneous requests', () => {
    it('awards XP exactly once when two requests race', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);

      const results = await Promise.allSettled([
        db.awardSlotXp(testUser.id, checkIn, slotId1),
        db.awardSlotXp(testUser.id, checkIn, slotId1),
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
      const checkIn2 = await db.createCheckIn(testUser.id, userRecipeId1, slotId1, true);

      const results = await Promise.allSettled([
        db.awardSlotXp(testUser.id, checkIn1, slotId1),
        db.awardSlotXp(testUser.id, checkIn2, slotId1),
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
