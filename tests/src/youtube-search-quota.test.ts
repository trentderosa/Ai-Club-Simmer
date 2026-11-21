import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase } from './db';

/**
 * 20261121180000_youtube_search_quota.sql
 *
 * youtube_search_quota is a server-only log. A pause recorded in one session
 * blocks a later session, which is what an AI server restart does.
 * Runs when local Postgres is up (CI). This file is not part of ai-server's tests.
 */
describe('youtube search quota cooldown', () => {
  let db: TestDatabase;

  const now = '2026-02-01T16:00:00.000Z';
  const until = '2026-02-02T08:00:00.000Z';
  const claimFn = 'claim_youtube_search(integer, timestamp with time zone)';
  const recordFn = 'record_youtube_quota_cooldown(timestamp with time zone, timestamp with time zone)';

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
  });

  async function claim(count: number, at: string): Promise<Date | null> {
    const result = await db.getPool().query(
      `SELECT claim_youtube_search($1::int, $2::timestamptz) AS blocked`,
      [count, at]
    );
    const blocked = result.rows[0].blocked as Date | null;
    return blocked ? new Date(blocked) : null;
  }

  async function record(pauseUntil: string, at: string): Promise<Date> {
    const result = await db.getPool().query(
      `SELECT record_youtube_quota_cooldown($1::timestamptz, $2::timestamptz) AS until`,
      [pauseUntil, at]
    );
    return new Date(result.rows[0].until as Date);
  }

  async function counts(): Promise<{ searches: number; pauses: number }> {
    const result = await db.getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE cooldown_until IS NULL)::int AS searches,
         COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL)::int AS pauses
       FROM youtube_search_quota`
    );
    return { searches: result.rows[0].searches as number, pauses: result.rows[0].pauses as number };
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

  it('keeps the pause across a new connection and does not record searches while it lasts', async () => {
    const first = await db.getPool().connect();
    try {
      const claimed = await first.query(
        `SELECT claim_youtube_search(2, $1::timestamptz) AS blocked`,
        [now]
      );
      expect(claimed.rows[0].blocked).toBeNull();
      const saved = await first.query(
        `SELECT record_youtube_quota_cooldown($1::timestamptz, $2::timestamptz) AS until`,
        [until, now]
      );
      expect(new Date(saved.rows[0].until as Date).toISOString()).toBe(until);
    } finally {
      first.release();
    }

    const restarted = await db.getPool().connect();
    try {
      const blocked = await restarted.query(
        `SELECT claim_youtube_search(1, $1::timestamptz) AS blocked`,
        [now]
      );
      expect(new Date(blocked.rows[0].blocked as Date).toISOString()).toBe(until);
    } finally {
      restarted.release();
    }

    expect(await counts()).toEqual({ searches: 2, pauses: 1 });

    expect(await claim(1, until)).toBeNull();
    // The two searches from earlier that day are still inside 36 hours, plus this one.
    expect(await counts()).toEqual({ searches: 3, pauses: 0 });
  });

  it('drops search rows once they are 36 hours old', async () => {
    expect(await claim(1, now)).toBeNull();
    const later = new Date(Date.parse(now) + 36 * 60 * 60 * 1000).toISOString();
    expect(await claim(1, later)).toBeNull();
    const rows = await db.getPool().query(`SELECT occurred_at FROM youtube_search_quota ORDER BY occurred_at`);
    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0].occurred_at as Date).toISOString()).toBe(later);
  });

  it('rejects a bad count or a pause outside the next 36 hours and writes nothing', async () => {
    await expect(claim(0, now)).rejects.toThrow(/out of range/);
    await expect(claim(7, now)).rejects.toThrow(/out of range/);
    await expect(record(now, now)).rejects.toThrow(/out of range/);
    const tooFar = new Date(Date.parse(now) + 36 * 60 * 60 * 1000 + 1000).toISOString();
    await expect(record(tooFar, now)).rejects.toThrow(/out of range/);
    const edge = new Date(Date.parse(now) + 36 * 60 * 60 * 1000).toISOString();
    expect((await record(edge, now)).toISOString()).toBe(edge);
    expect(await counts()).toEqual({ searches: 0, pauses: 1 });
  });

  it('lets only the database lock serialize two claims, and both record when no pause is set', async () => {
    const [a, b] = await Promise.all([claim(1, now), claim(1, now)]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(await counts()).toEqual({ searches: 2, pauses: 0 });

    await db.cleanupTestData();
    await record(until, now);
    const [c, d] = await Promise.all([claim(1, now), claim(1, now)]);
    expect(c?.toISOString()).toBe(until);
    expect(d?.toISOString()).toBe(until);
    expect(await counts()).toEqual({ searches: 0, pauses: 1 });
  });

  it('is service-role only: RLS on, no policies, clients cannot read, write, or execute', async () => {
    const flags = await db.getPool().query(
      `SELECT c.relrowsecurity AS rls,
              (SELECT COUNT(*)::int FROM pg_policies p WHERE p.tablename = 'youtube_search_quota') AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'youtube_search_quota'`
    );
    expect(flags.rows[0]).toEqual({ rls: true, policies: 0 });

    expect(await db.hasFunctionPrivilege('anon', claimFn)).toBe(false);
    expect(await db.hasFunctionPrivilege('authenticated', claimFn)).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', claimFn)).toBe(true);
    expect(await db.hasFunctionPrivilege('anon', recordFn)).toBe(false);
    expect(await db.hasFunctionPrivilege('authenticated', recordFn)).toBe(false);
    expect(await db.hasFunctionPrivilege('service_role', recordFn)).toBe(true);

    const sequence = await db.getPool().query(
      `SELECT pg_get_serial_sequence('public.youtube_search_quota', 'id') AS seq`
    );
    const seq = sequence.rows[0].seq as string;
    for (const role of ['anon', 'authenticated'] as const) {
      const table = await db.getPool().query(
        `SELECT has_table_privilege($1, 'public.youtube_search_quota', 'SELECT') AS ok`,
        [role]
      );
      expect(table.rows[0].ok).toBe(false);
      const usage = await db.getPool().query(
        `SELECT has_sequence_privilege($1, $2, 'USAGE') AS ok`,
        [role, seq]
      );
      expect(usage.rows[0].ok).toBe(false);
      await expect(asRole(role, 'SELECT * FROM youtube_search_quota')).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, `SELECT claim_youtube_search(1, $1::timestamptz)`, [now])
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, `INSERT INTO youtube_search_quota (occurred_at) VALUES ($1::timestamptz)`, [now])
      ).rejects.toThrow(/permission denied/);
    }

    const allowed = await asRole(
      'service_role',
      `SELECT claim_youtube_search(1, $1::timestamptz) AS blocked`,
      [now]
    );
    expect(allowed).toEqual([{ blocked: null }]);
    expect(await counts()).toEqual({ searches: 1, pauses: 0 });
  });
});
