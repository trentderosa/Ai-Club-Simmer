import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * Task 2: the ai-server check-in flow, at the database level.
 *
 * The ai-server saves a check-in with the service-role key, then calls
 * award_slot_xp(check_in_id) as service_role. These tests replay that
 * sequence (createCheckIn, then the service_role awardSlotXp helper) and
 * check that XP lands with the anti-farming rules intact.
 */
describe('ai-server check-in flow: XP via service_role', () => {
  let db: TestDatabase;
  let user: TestUser;
  let slotId: number;
  let slotXp: number;
  let userRecipeId: string;

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

    user = await db.createTestUser(`test-flow-${Date.now()}@example.com`);
    await db.createProfile(user.id);
    slotId = await db.getSlotId(1);
    slotXp = await db.getSlotXpValue(slotId);
    userRecipeId = await db.createUserRecipe(user.id, slotId);
  });

  async function checkInAndAward(): Promise<{ checkInId: string; xp: number; capped: boolean }> {
    const checkInId = await db.createCheckIn(user.id, userRecipeId, slotId);
    const result = await db.awardSlotXp(checkInId);
    return { checkInId, xp: result.out_xp_awarded, capped: result.out_capped };
  }

  it('XP lands after a check-in', async () => {
    const { checkInId, xp } = await checkInAndAward();

    expect(slotXp).toBeGreaterThan(0);
    expect(xp).toBe(slotXp);
    expect(await db.getUserTotalXp(user.id)).toBe(slotXp);
    expect(await db.getXpEventCount(checkInId)).toBe(1);
    expect(await db.getCheckInIsRepeat(checkInId)).toBe(false);
  });

  it('a repeat check-in earns 50% of the slot XP', async () => {
    await checkInAndAward();
    const repeat = await checkInAndAward();

    expect(repeat.xp).toBe(Math.floor((slotXp * 50) / 100));
    expect(await db.getCheckInIsRepeat(repeat.checkInId)).toBe(true);
    expect(await db.getUserTotalXp(user.id)).toBe(slotXp + repeat.xp);
  });

  it('repeat XP is capped at 100 per week, then 0', async () => {
    await checkInAndAward();
    const repeatXp = Math.floor((slotXp * 50) / 100);
    const cap = 100;

    let repeatTotal = 0;
    let sawCap = false;
    for (let i = 0; i < 10 && !sawCap; i++) {
      const r = await checkInAndAward();
      const expected = Math.min(repeatXp, cap - repeatTotal);
      expect(r.xp).toBe(expected);
      repeatTotal += r.xp;
      sawCap = r.capped;
    }

    expect(sawCap).toBe(true);
    expect(repeatTotal).toBe(cap);

    const after = await checkInAndAward();
    expect(after.xp).toBe(0);
    expect(after.capped).toBe(true);
    expect(await db.getUserTotalXp(user.id)).toBe(slotXp + cap);
  });

  it('a second award for the same check_in_id does not double-count and keeps the check-in', async () => {
    const { checkInId } = await checkInAndAward();

    await expect(db.awardSlotXp(checkInId)).rejects.toThrow();

    expect(await db.getXpEventCount(checkInId)).toBe(1);
    expect(await db.getUserTotalXp(user.id)).toBe(slotXp);
    // The check-in row survives the failed award (still first completion).
    expect(await db.getCheckInIsRepeat(checkInId)).toBe(false);
  });
});
