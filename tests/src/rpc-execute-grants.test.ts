import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * EXECUTE lockdown for Supabase advisor warnings on:
 *   public.award_slot_xp(uuid)
 *   public.rls_auto_enable()
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

  describe('has_function_privilege: rls_auto_enable()', () => {
    it('denies EXECUTE to anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'rls_auto_enable()')).toBe(false);
    });

    it('denies EXECUTE to authenticated', async () => {
      expect(await db.hasFunctionPrivilege('authenticated', 'rls_auto_enable()')).toBe(false);
    });

    it('denies EXECUTE to service_role (no explicit grant; PUBLIC revoked)', async () => {
      // Lockdown only REVOKEs PUBLIC/anon/authenticated; it does not GRANT
      // service_role. After PUBLIC is revoked, service_role has no EXECUTE.
      expect(await db.hasFunctionPrivilege('service_role', 'rls_auto_enable()')).toBe(false);
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

    it('anon cannot execute rls_auto_enable', async () => {
      const result = await db.tryRlsAutoEnableAsRole('anon');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('authenticated cannot execute rls_auto_enable', async () => {
      const result = await db.tryRlsAutoEnableAsRole('authenticated');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
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
