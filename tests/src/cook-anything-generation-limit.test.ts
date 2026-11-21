import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * 20261120150000_cook_anything_generation_limits.sql
 * 20261121200000_cook_anything_generation_refund.sql
 *
 * cook_anything_generation_hits is a server-only cache. The count survives a
 * new database session, which is what an AI server restart does.
 */
describe('cook anything generation rate limit', () => {
  let db: TestDatabase;
  let user: TestUser;
  let other: TestUser;

  const t0 = '2026-11-20T12:00:00.000Z';
  const fn = 'try_cook_anything_generation(uuid, integer, integer, timestamp with time zone)';

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
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    user = await db.createTestUser(`test-cook-limit-${stamp}@simmer.invalid`);
    other = await db.createTestUser(`test-cook-limit-b-${stamp}@simmer.invalid`);
  });

  async function allow(userId: string, windowMs: number, max: number, now: string): Promise<boolean> {
    const result = await db.getPool().query(
      `SELECT try_cook_anything_generation($1::uuid, $2::int, $3::int, $4::timestamptz) AS allowed`,
      [userId, windowMs, max, now]
    );
    return result.rows[0].allowed === true;
  }

  async function refund(userId: string, windowMs: number, now: string): Promise<boolean> {
    const result = await db.getPool().query(
      `SELECT refund_cook_anything_generation($1::uuid, $2::int, $3::timestamptz) AS refunded`,
      [userId, windowMs, now]
    );
    return result.rows[0].refunded === true;
  }

  async function hitCount(userId: string): Promise<number> {
    const result = await db.getPool().query(
      `SELECT COUNT(*)::int AS n FROM cook_anything_generation_hits WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0].n as number;
  }

  async function asRole(role: 'anon' | 'authenticated' | 'service_role', sql: string, params: unknown[] = []): Promise<unknown[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('keeps the window across a new connection and drops a hit exactly one window old', async () => {
    const first = await db.getPool().connect();
    try {
      const result = await first.query(
        `SELECT try_cook_anything_generation($1::uuid, 1000, 1, $2::timestamptz) AS allowed`,
        [user.id, t0]
      );
      expect(result.rows[0].allowed).toBe(true);
    } finally {
      first.release();
    }

    const restarted = await db.getPool().connect();
    try {
      const denied = await restarted.query(
        `SELECT try_cook_anything_generation($1::uuid, 1000, 1, $2::timestamptz) AS allowed`,
        [user.id, '2026-11-20T12:00:00.500Z']
      );
      expect(denied.rows[0].allowed).toBe(false);
      expect(await hitCount(user.id)).toBe(1);

      const again = await restarted.query(
        `SELECT try_cook_anything_generation($1::uuid, 1000, 1, $2::timestamptz) AS allowed`,
        [user.id, '2026-11-20T12:00:01.000Z']
      );
      expect(again.rows[0].allowed).toBe(true);
    } finally {
      restarted.release();
    }

    expect(await hitCount(user.id)).toBe(1);
    const rows = await db.getPool().query(
      `SELECT occurred_at FROM cook_anything_generation_hits WHERE user_id = $1`,
      [user.id]
    );
    expect(new Date(rows.rows[0].occurred_at as string).toISOString()).toBe('2026-11-20T12:00:01.000Z');
  });

  it('caps each user separately and does not insert a denied hit', async () => {
    expect(await allow(user.id, 60_000, 2, t0)).toBe(true);
    expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:01.000Z')).toBe(true);
    expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:02.000Z')).toBe(false);
    expect(await hitCount(user.id)).toBe(2);
    expect(await allow(other.id, 60_000, 2, '2026-11-20T12:00:02.000Z')).toBe(true);
    expect(await hitCount(other.id)).toBe(1);
  });

  it('lets only one of two concurrent calls through when the cap is one', async () => {
    const [a, b] = await Promise.all([
      allow(user.id, 60_000, 1, t0),
      allow(user.id, 60_000, 1, t0),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await hitCount(user.id)).toBe(1);
  });

  it('rejects a window or max outside the configured bounds and writes nothing', async () => {
    await expect(allow(user.id, 0, 1, t0)).rejects.toThrow(/out of range/);
    await expect(allow(user.id, 999, 1, t0)).rejects.toThrow(/out of range/);
    await expect(allow(user.id, 86_400_001, 1, t0)).rejects.toThrow(/out of range/);
    await expect(allow(user.id, 1000, 0, t0)).rejects.toThrow(/out of range/);
    await expect(allow(user.id, 1000, 101, t0)).rejects.toThrow(/out of range/);
    expect(await hitCount(user.id)).toBe(0);
  });

  it('is service-role only: RLS on, no policies, clients cannot read, write, or execute', async () => {
    const flags = await db.getPool().query(
      `SELECT c.relrowsecurity AS rls,
              (SELECT COUNT(*)::int FROM pg_policies p WHERE p.tablename = 'cook_anything_generation_hits') AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'cook_anything_generation_hits'`
    );
    expect(flags.rows[0]).toEqual({ rls: true, policies: 0 });

    expect(await db.hasFunctionPrivilege('anon', fn)).toBe(false);
    expect(await db.hasFunctionPrivilege('authenticated', fn)).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', fn)).toBe(true);

    for (const role of ['anon', 'authenticated'] as const) {
      const table = await db.getPool().query(
        `SELECT has_table_privilege($1, 'public.cook_anything_generation_hits', 'SELECT') AS ok`,
        [role]
      );
      expect(table.rows[0].ok).toBe(false);
      await expect(asRole(role, 'SELECT * FROM cook_anything_generation_hits')).rejects.toThrow(/permission denied/);
      await expect(
        asRole(
          role,
          `SELECT try_cook_anything_generation($1::uuid, 1000, 1, $2::timestamptz)`,
          [user.id, t0]
        )
      ).rejects.toThrow(/permission denied/);
    }

    await expect(
      asRole(
        'authenticated',
        `INSERT INTO cook_anything_generation_hits (user_id, occurred_at) VALUES ($1::uuid, $2::timestamptz)`,
        [user.id, t0]
      )
    ).rejects.toThrow(/permission denied/);

    const allowed = await asRole(
      'service_role',
      `SELECT try_cook_anything_generation($1::uuid, 1000, 1, $2::timestamptz) AS allowed`,
      [user.id, t0]
    );
    expect(allowed).toEqual([{ allowed: true }]);
    expect(await hitCount(user.id)).toBe(1);
  });

  describe('refund_cook_anything_generation', () => {
    const refundFn = 'refund_cook_anything_generation(uuid, integer, timestamp with time zone)';

    it('removes exactly one hit, the newest, and restores capacity', async () => {
      expect(await allow(user.id, 60_000, 2, t0)).toBe(true);
      expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:01.000Z')).toBe(true);
      expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:02.000Z')).toBe(false);

      expect(await refund(user.id, 60_000, '2026-11-20T12:00:02.000Z')).toBe(true);
      expect(await hitCount(user.id)).toBe(1);
      const left = await db.getPool().query(
        `SELECT occurred_at FROM cook_anything_generation_hits WHERE user_id = $1`,
        [user.id]
      );
      expect(new Date(left.rows[0].occurred_at as string).toISOString()).toBe(t0);

      expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:03.000Z')).toBe(true);
      expect(await allow(user.id, 60_000, 2, '2026-11-20T12:00:04.000Z')).toBe(false);
    });

    it('is idempotent: with nothing to refund it returns false and writes nothing', async () => {
      expect(await refund(user.id, 60_000, t0)).toBe(false);
      expect(await allow(user.id, 60_000, 5, t0)).toBe(true);
      expect(await refund(user.id, 60_000, t0)).toBe(true);
      expect(await refund(user.id, 60_000, t0)).toBe(false);
      expect(await hitCount(user.id)).toBe(0);
    });

    it('does not refund a hit that is outside the window', async () => {
      expect(await allow(user.id, 1000, 5, t0)).toBe(true);
      expect(await refund(user.id, 1000, '2026-11-20T12:00:01.000Z')).toBe(false);
    });

    it('never touches another user\'s hits', async () => {
      expect(await allow(other.id, 60_000, 5, t0)).toBe(true);
      expect(await refund(user.id, 60_000, t0)).toBe(false);
      expect(await hitCount(other.id)).toBe(1);

      expect(await allow(user.id, 60_000, 5, t0)).toBe(true);
      expect(await refund(user.id, 60_000, t0)).toBe(true);
      expect(await hitCount(user.id)).toBe(0);
      expect(await hitCount(other.id)).toBe(1);
    });

    it('rejects a window outside the configured bounds', async () => {
      await expect(refund(user.id, 999, t0)).rejects.toThrow(/out of range/);
      await expect(refund(user.id, 86_400_001, t0)).rejects.toThrow(/out of range/);
    });

    it('is service-role only: anon and authenticated get permission denied', async () => {
      expect(await db.hasFunctionPrivilege('anon', refundFn)).toBe(false);
      expect(await db.hasFunctionPrivilege('authenticated', refundFn)).toBe(false);
      expect(await db.hasFunctionPrivilege('service_role', refundFn)).toBe(true);

      expect(await allow(user.id, 60_000, 5, t0)).toBe(true);
      for (const role of ['anon', 'authenticated'] as const) {
        await expect(
          asRole(role, `SELECT refund_cook_anything_generation($1::uuid, 60000, $2::timestamptz)`, [user.id, t0])
        ).rejects.toThrow(/permission denied/);
      }
      expect(await hitCount(user.id)).toBe(1);

      const refunded = await asRole(
        'service_role',
        `SELECT refund_cook_anything_generation($1::uuid, 60000, $2::timestamptz) AS refunded`,
        [user.id, t0]
      );
      expect(refunded).toEqual([{ refunded: true }]);
      expect(await hitCount(user.id)).toBe(0);
    });
  });
});
