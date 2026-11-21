import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TestDatabase } from './db';

const { Pool } = pg;

/**
 * Catalog check: every SECURITY DEFINER function in public (except trigger
 * functions) must be unreachable by anon, and unreachable by authenticated
 * unless it is an intentionally client-facing RPC listed below.
 *
 * Allowlist = SECURITY DEFINER functions with GRANT EXECUTE ... TO authenticated
 * in migrations (get_user_total_xp is also granted but is not SECURITY DEFINER).
 * Do NOT add server-only functions here.
 */
const CLIENT_FACING_FUNCTIONS = [
  'get_my_plan',
  'get_my_plan_summary',
  'get_my_badges',
  'get_my_recipe_book',
  'get_my_recipe_book_v2',
];

interface SecDefFunction {
  signature: string;
  name: string;
  anon: boolean;
  authenticated: boolean;
}

describe('SECURITY DEFINER function grants catalog', () => {
  let db: TestDatabase;
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    await db.dropAllTables();
    await db.runAllMigrations();
    await db.setupRoles();
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/simmer_test',
    });
  });

  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  async function listSecurityDefinerFunctions(): Promise<SecDefFunction[]> {
    const result = await pool.query(`
      SELECT p.proname AS name,
             p.oid::regprocedure::text AS signature,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND p.prorettype <> 'pg_catalog.trigger'::regtype
      ORDER BY p.proname, p.oid
    `);
    return result.rows;
  }

  it('simulates Supabase default privileges (anon can EXECUTE a new function)', async () => {
    await pool.query('CREATE FUNCTION public.__grant_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
    try {
      const result = await pool.query(
        `SELECT has_function_privilege('anon', 'public.__grant_probe()', 'EXECUTE') AS allowed`
      );
      expect(result.rows[0].allowed).toBe(true);
    } finally {
      await pool.query('DROP FUNCTION IF EXISTS public.__grant_probe()');
    }
  });

  it('finds SECURITY DEFINER functions and every allowlisted function exists', async () => {
    const fns = await listSecurityDefinerFunctions();
    const names = new Set(fns.map((f) => f.name));
    expect(fns.length).toBeGreaterThan(0);
    const missing = CLIENT_FACING_FUNCTIONS.filter((n) => !names.has(n));
    expect(missing, `Allowlisted functions not found as SECURITY DEFINER: ${missing.join(', ')}`).toEqual([]);
  });

  it('anon cannot EXECUTE any SECURITY DEFINER function (including allowlisted)', async () => {
    const offenders = (await listSecurityDefinerFunctions())
      .filter((f) => f.anon)
      .map((f) => f.signature);
    expect(offenders, `anon can EXECUTE: ${offenders.join(', ')}`).toEqual([]);
  });

  it('authenticated cannot EXECUTE SECURITY DEFINER functions outside the allowlist', async () => {
    const offenders = (await listSecurityDefinerFunctions())
      .filter((f) => f.authenticated && !CLIENT_FACING_FUNCTIONS.includes(f.name))
      .map((f) => f.signature);
    expect(offenders, `authenticated can EXECUTE server-only: ${offenders.join(', ')}`).toEqual([]);
  });

  it('authenticated can EXECUTE every allowlisted function', async () => {
    const lacking = (await listSecurityDefinerFunctions())
      .filter((f) => CLIENT_FACING_FUNCTIONS.includes(f.name) && !f.authenticated)
      .map((f) => f.signature);
    expect(lacking, `authenticated cannot EXECUTE: ${lacking.join(', ')}`).toEqual([]);
  });
});
