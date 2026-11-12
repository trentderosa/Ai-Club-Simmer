import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestDatabase } from './db';

/**
 * EXECUTE lockdown for the Supabase advisor warning on:
 *   public.rls_auto_enable()
 *
 * The stub created by runAllMigrations() exists only so these tests can
 * assert EXECUTE ACLs. It is not a copy of the prod function body/shape.
 */
describe('rls_auto_enable EXECUTE grants lockdown', () => {
  let db: TestDatabase;

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
});

/**
 * The lockdown migration must apply on a fresh DB that lacks rls_auto_enable(),
 * and also when the function is present (prod / stubbed local).
 */
describe('rls_auto_enable lockdown migration apply (with and without the function)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies cleanly when public.rls_auto_enable() is absent', async () => {
    await db.dropAllTables();
    await expect(
      db.runAllMigrations({ stubRlsAutoEnable: false })
    ).resolves.toBeUndefined();

    expect(await db.hasRlsAutoEnable()).toBe(false);
    expect(await db.hasFunctionPrivilege('anon', 'award_slot_xp(uuid)')).toBe(false);
    expect(await db.hasFunctionPrivilege('authenticated', 'award_slot_xp(uuid)')).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', 'award_slot_xp(uuid)')).toBe(true);
  });

  it('applies cleanly when public.rls_auto_enable() is present and revokes client EXECUTE', async () => {
    await db.dropAllTables();
    await expect(
      db.runAllMigrations({ stubRlsAutoEnable: true })
    ).resolves.toBeUndefined();

    expect(await db.hasRlsAutoEnable()).toBe(true);
    expect(await db.hasFunctionPrivilege('anon', 'rls_auto_enable()')).toBe(false);
    expect(await db.hasFunctionPrivilege('authenticated', 'rls_auto_enable()')).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', 'rls_auto_enable()')).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', 'award_slot_xp(uuid)')).toBe(true);
  });
});
