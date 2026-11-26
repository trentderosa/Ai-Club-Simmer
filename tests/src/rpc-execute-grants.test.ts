import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * EXECUTE lockdown for Supabase advisor warnings on:
 *   public.award_slot_xp(uuid)
 *   public.refund_cook_anything_generation(uuid, integer, timestamptz)
 *   public.personalize_my_path() (authenticated only; see personalized-path.test.ts)
 */
describe('RPC EXECUTE grants lockdown', () => {
  let db: TestDatabase;
  let testUser: TestUser;
  let slotId1: number;
  let userRecipeId1: string;

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

    testUser = await db.createTestUser(`test-rpc-${Date.now()}@example.com`);
    await db.createProfile(testUser.id);
    slotId1 = await db.getSlotId(1);
    userRecipeId1 = await db.createUserRecipe(testUser.id, slotId1);
  });

  describe('has_function_privilege: award_slot_xp(uuid)', () => {
    it('denies EXECUTE to anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'award_slot_xp(uuid)')).toBe(false);
    });

    it('denies EXECUTE to authenticated', async () => {
      expect(await db.hasFunctionPrivilege('authenticated', 'award_slot_xp(uuid)')).toBe(false);
    });

    it('allows EXECUTE to service_role', async () => {
      expect(await db.hasFunctionPrivilege('service_role', 'award_slot_xp(uuid)')).toBe(true);
    });
  });

  describe('runtime EXECUTE denials', () => {
    it('anon calling award_slot_xp gets permission denied', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.tryAwardSlotXpAsRole(checkIn, 'anon');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('authenticated calling award_slot_xp gets permission denied', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const result = await db.tryAwardSlotXpAsRole(checkIn, 'authenticated', testUser.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });
  });

  describe('has_function_privilege: award_generated_recipe_xp(uuid)', () => {
    it('denies EXECUTE to anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'award_generated_recipe_xp(uuid)')).toBe(false);
    });

    it('denies EXECUTE to authenticated', async () => {
      expect(await db.hasFunctionPrivilege('authenticated', 'award_generated_recipe_xp(uuid)')).toBe(false);
    });

    it('allows EXECUTE to service_role', async () => {
      expect(await db.hasFunctionPrivilege('service_role', 'award_generated_recipe_xp(uuid)')).toBe(true);
    });
  });

  describe('has_function_privilege: refund_cook_anything_generation', () => {
    const fn = 'refund_cook_anything_generation(uuid, integer, timestamp with time zone)';

    it('denies EXECUTE to anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', fn)).toBe(false);
    });

    it('denies EXECUTE to authenticated', async () => {
      expect(await db.hasFunctionPrivilege('authenticated', fn)).toBe(false);
    });

    it('allows EXECUTE to service_role', async () => {
      expect(await db.hasFunctionPrivilege('service_role', fn)).toBe(true);
    });
  });

  describe('has_function_privilege: personalize_my_path()', () => {
    const fn = 'personalize_my_path()';

    it('denies EXECUTE to anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', fn)).toBe(false);
    });

    it('allows EXECUTE to authenticated', async () => {
      expect(await db.hasFunctionPrivilege('authenticated', fn)).toBe(true);
    });
  });

  describe('service_role XP path (ai-server style)', () => {
    it('awards XP end to end via service_role', async () => {
      const checkIn = await db.createCheckIn(testUser.id, userRecipeId1, slotId1);
      const slotXp = await db.getSlotXpValue(slotId1);

      const result = await db.awardSlotXp(checkIn);

      expect(result.out_xp_awarded).toBe(slotXp);
      expect(result.out_is_first_completion).toBe(true);
      expect(await db.getUserTotalXp(testUser.id)).toBe(slotXp);
      expect(await db.getXpEventCount(checkIn)).toBe(1);
    });
  });
});
