import pg, { Pool as PoolType } from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const CLIENT_ROLES = ['authenticated', 'anon'] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];

function assertClientRole(role: string): asserts role is ClientRole {
  if (!(CLIENT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`Refusing SET ROLE for non-client role: ${role}`);
  }
}

export interface TestUser {
  id: string;
  email: string;
}

export interface XpAwardResult {
  out_xp_awarded: number;
  out_is_first_completion: boolean;
  out_weekly_repeat_remaining: number;
  out_capped: boolean;
}

export class TestDatabase {
  private pool: PoolType;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/simmer_test',
    });
  }

  async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async runMigration(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /**
   * Shared Supabase-like role bootstrap (N1: single helper for migrations + setupRoles).
   */
  private async ensureSupabaseRoles(): Promise<void> {
    await this.pool.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END
      $roles$;

      GRANT authenticated TO postgres;
      GRANT anon TO postgres;
      GRANT service_role TO postgres;
      GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
    `);
  }

  /**
   * N6: Run all migrations from supabase/migrations/ in sorted order.
   * This ensures future migrations are automatically included.
   */
  async runAllMigrations(): Promise<void> {
    await this.ensureSupabaseRoles();

    const migrationsDir = path.join(__dirname, '../..', 'supabase/migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await this.pool.query(sql);
    }
  }

  async dropAllTables(): Promise<void> {
    // Drop and recreate the public schema to ensure a clean slate.
    // This handles all tables, functions, types, triggers, etc. in one go,
    // avoiding race conditions with PostgreSQL's type catalog.
    // B3: Recreate pgcrypto after schema drop since it was installed in public.
    await this.pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO PUBLIC;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);
  }

  /**
   * Setup roles and permissions to simulate Supabase environment.
   * This allows tests to run as authenticated/anon/service_role with proper RLS.
   * Must re-apply security restrictions AFTER granting broad table access.
   */
  async setupRoles(): Promise<void> {
    await this.ensureSupabaseRoles();

    await this.pool.query(`
      -- Grant table privileges to authenticated role (like Supabase does)
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
      
      -- Grant read access to anon
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
      
      -- Re-apply security restrictions that the migration set (order matters!)
      -- B4 FIX: xp_config is read-only for clients
      REVOKE INSERT, UPDATE, DELETE ON xp_config FROM anon, authenticated;
      
      -- S5 FIX: user_recipes - no INSERT for clients (service-role only)
      REVOKE INSERT ON user_recipes FROM anon, authenticated;
      
      -- xp_events - no INSERT for clients (only via SECURITY DEFINER function)
      REVOKE INSERT, UPDATE, DELETE ON xp_events FROM anon, authenticated;
      
      -- user_slot_completions - no INSERT for clients (only via SECURITY DEFINER function)
      REVOKE INSERT, UPDATE, DELETE ON user_slot_completions FROM anon, authenticated;

      -- Re-assert RPC lockdown after broad GRANTs (migrations already set these)
      REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.award_slot_xp(UUID) TO service_role;
    `);
  }

  async cleanupTestData(): Promise<void> {
    await this.pool.query('DELETE FROM xp_events');
    await this.pool.query('DELETE FROM check_ins');
    await this.pool.query('DELETE FROM user_recipes');
    await this.pool.query('DELETE FROM user_slot_completions');
    await this.pool.query('DELETE FROM profiles');
    await this.pool.query("DELETE FROM auth.users WHERE email LIKE 'test-%'");
  }

  async createTestUser(email: string): Promise<TestUser> {
    const result = await this.pool.query(
      `INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at, confirmation_token,
        recovery_token, email_change_token_new, email_change
      ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(),
        'authenticated',
        'authenticated',
        $1,
        crypt('testpassword', gen_salt('bf')),
        NOW(),
        NOW(),
        NOW(),
        '',
        '',
        '',
        ''
      ) RETURNING id, email`,
      [email]
    );
    return { id: result.rows[0].id, email: result.rows[0].email };
  }

  async createProfile(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO profiles (id, goals, experience_level, equipment, budget, days_per_week, minutes_per_session, onboarding_completed)
       VALUES ($1, 'Learn basics', 'never_cooked', ARRAY['knife', 'pot', 'pan'], 'low', 3, 30, TRUE)`,
      [userId]
    );
  }

  async getSlotId(slotOrder: number): Promise<number> {
    const result = await this.pool.query(
      'SELECT id FROM path_slots WHERE slot_order = $1',
      [slotOrder]
    );
    return result.rows[0].id;
  }

  async getSlotXpValue(slotId: number): Promise<number> {
    const result = await this.pool.query(
      'SELECT xp_value FROM path_slots WHERE id = $1',
      [slotId]
    );
    return result.rows[0].xp_value;
  }

  /**
   * Create a user_recipe. Uses service-role style insert (superuser bypasses RLS)
   * since clients can no longer insert recipes directly (S5 fix).
   */
  async createUserRecipe(userId: string, slotId: number): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO user_recipes (user_id, slot_id, recipe_json)
       VALUES ($1, $2, '{"title": "Test Recipe", "steps": []}')
       RETURNING id`,
      [userId, slotId]
    );
    return result.rows[0].id;
  }

  async createCheckIn(
    userId: string,
    userRecipeId: string,
    slotId: number
  ): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO check_ins (user_id, user_recipe_id, slot_id, difficulty_rating)
       VALUES ($1, $2, $3, 'ok')
       RETURNING id`,
      [userId, userRecipeId, slotId]
    );
    return result.rows[0].id;
  }

  async getCheckInIsRepeat(checkInId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT is_repeat FROM check_ins WHERE id = $1',
      [checkInId]
    );
    return result.rows[0].is_repeat;
  }

  /**
   * Award XP for a check-in as service_role (the production ai-server path).
   * Sets both SET ROLE service_role (EXECUTE grant) and the JWT role claim
   * (ownership bypass inside the SECURITY DEFINER body).
   */
  async awardSlotXp(checkInId: string): Promise<XpAwardResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
      );
      
      const result = await client.query(
        'SELECT * FROM award_slot_xp($1)',
        [checkInId]
      );
      
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Try to execute award_slot_xp as a client role (authenticated or anon).
   */
  async tryAwardSlotXpAsRole(
    checkInId: string,
    role: ClientRole,
    userId?: string
  ): Promise<{ success: boolean; error?: string }> {
    assertClientRole(role);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (userId) {
        await client.query(
          `SELECT set_config('request.jwt.claim.sub', $1, true)`,
          [userId]
        );
      }
      await client.query(
        `SELECT set_config('request.jwt.claim.role', $1, true)`,
        [role]
      );
      await client.query('SELECT * FROM award_slot_xp($1)', [checkInId]);
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  /**
   * has_function_privilege for a role and function signature.
   */
  async hasFunctionPrivilege(
    role: string,
    functionSignature: string,
    privilege: string = 'EXECUTE'
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT has_function_privilege($1, $2::regprocedure, $3) AS allowed`,
      [role, `public.${functionSignature}`, privilege]
    );
    return result.rows[0].allowed === true;
  }

  /**
   * Award XP as a specific user (with RLS enabled).
   * S2 FIX: This properly tests RLS by setting the role and JWT claims.
   */
  async awardSlotXpAsUser(checkInId: string, userId: string): Promise<XpAwardResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true)`,
        [userId]
      );
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`
      );
      
      const result = await client.query(
        'SELECT * FROM award_slot_xp($1)',
        [checkInId]
      );
      
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getUserTotalXp(userId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COALESCE(SUM(xp_awarded), 0) as total FROM xp_events WHERE user_id = $1',
      [userId]
    );
    return parseInt(result.rows[0].total);
  }

  async getXpEventCount(checkInId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM xp_events WHERE check_in_id = $1',
      [checkInId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * S2 FIX: Try to insert into xp_events as authenticated role (should fail due to RLS).
   */
  async tryClientInsertXpEventAsRole(
    userId: string,
    checkInId: string,
    slotId: number,
    xpAmount: number
  ): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true)`,
        [userId]
      );
      
      await client.query(
        `INSERT INTO xp_events (user_id, check_in_id, slot_id, xp_awarded, is_first_completion)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, checkInId, slotId, xpAmount]
      );
      
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  /**
   * S2 FIX: Try to update xp_config as authenticated role (should fail).
   */
  async tryClientUpdateXpConfigAsRole(key: string, value: number): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      
      await client.query(
        `UPDATE xp_config SET value = $2 WHERE key = $1`,
        [key, value]
      );
      
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  /**
   * S5 FIX: Try to insert user_recipe as authenticated role (should fail).
   */
  async tryClientInsertUserRecipeAsRole(
    userId: string,
    slotId: number
  ): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true)`,
        [userId]
      );
      
      await client.query(
        `INSERT INTO user_recipes (user_id, slot_id, recipe_json)
         VALUES ($1, $2, '{"title": "Fake Recipe"}')`,
        [userId, slotId]
      );
      
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  /**
   * S2 FIX: Try to create check-in with mismatched slot as authenticated role.
   */
  async tryClientInsertCheckInAsRole(
    userId: string,
    userRecipeId: string,
    slotId: number
  ): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true)`,
        [userId]
      );
      
      await client.query(
        `INSERT INTO check_ins (user_id, user_recipe_id, slot_id, difficulty_rating)
         VALUES ($1, $2, $3, 'ok')`,
        [userId, userRecipeId, slotId]
      );
      
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  async hasClientInsertPolicy(tableName: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM pg_policies 
       WHERE tablename = $1 AND cmd = 'INSERT'`,
      [tableName]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  async setXpConfig(key: string, value: number): Promise<void> {
    await this.pool.query(
      `UPDATE xp_config SET value = $2 WHERE key = $1`,
      [key, value]
    );
  }

  async resetXpConfig(): Promise<void> {
    await this.pool.query(`UPDATE xp_config SET value = 50 WHERE key = 'repeat_xp_percent'`);
    await this.pool.query(`UPDATE xp_config SET value = 100 WHERE key = 'weekly_repeat_cap'`);
  }

  async backdateCheckIn(checkInId: string, daysAgo: number): Promise<void> {
    await this.pool.query(
      `UPDATE check_ins SET created_at = NOW() - make_interval(days => $2) WHERE id = $1`,
      [checkInId, daysAgo]
    );
  }

  /**
   * SQL twin of the ai-server reconcile scan (ai-server/src/jobs/supabase-reconcile-source.ts),
   * which runs the same anti-join over PostgREST: check-ins in [from, to] with no
   * xp_events row, oldest first, at most `limit`.
   */
  async findCheckInsMissingXp(
    from: Date,
    to: Date,
    limit: number
  ): Promise<{ check_in_id: string; slot_id: number; created_at: string }[]> {
    const result = await this.pool.query(
      `SELECT c.id AS check_in_id, c.slot_id, c.created_at
         FROM check_ins c
        WHERE NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
          AND c.created_at >= $1
          AND c.created_at <= $2
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT $3`,
      [from, to, limit]
    );
    return result.rows.map((row) => ({
      check_in_id: row.check_in_id,
      slot_id: row.slot_id,
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  async backdateXpEvent(checkInId: string, daysAgo: number): Promise<void> {
    await this.pool.query(
      `UPDATE xp_events SET created_at = NOW() - make_interval(days => $2) WHERE check_in_id = $1`,
      [checkInId, daysAgo]
    );
  }

  async isSlotCompleted(userId: string, slotId: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM user_slot_completions 
       WHERE user_id = $1 AND slot_id = $2`,
      [userId, slotId]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  getPool(): PoolType {
    return this.pool;
  }

  /**
   * Get a slot's full details including recipe input columns
   */
  async getSlotDetails(slotOrder: number): Promise<{
    id: number;
    slot_order: number;
    dish_name: string;
    xp_value: number;
    steps: number | null;
    ingredients: number | null;
    cook_minutes: number | null;
  }> {
    const result = await this.pool.query(
      `SELECT id, slot_order, dish_name, xp_value, steps, ingredients, cook_minutes 
       FROM path_slots WHERE slot_order = $1`,
      [slotOrder]
    );
    return result.rows[0];
  }

  /**
   * Get XP config value (returns number for NUMERIC type)
   */
  async getXpConfigValue(key: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT value FROM xp_config WHERE key = $1',
      [key]
    );
    return parseFloat(result.rows[0].value);
  }

  /**
   * Update a slot's recipe input columns (superuser bypass)
   */
  async updateSlotInputs(
    slotId: number,
    steps: number,
    ingredients: number,
    cookMinutes: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE path_slots SET steps = $2, ingredients = $3, cook_minutes = $4 WHERE id = $1`,
      [slotId, steps, ingredients, cookMinutes]
    );
  }

  /**
   * Get XP event details by check_in_id
   */
  async getXpEventDetails(checkInId: string): Promise<{
    xp_awarded: number;
    is_first_completion: boolean;
  } | null> {
    const result = await this.pool.query(
      'SELECT xp_awarded, is_first_completion FROM xp_events WHERE check_in_id = $1',
      [checkInId]
    );
    return result.rows[0] || null;
  }

  /**
   * Reset XP weights to default formula values
   */
  async resetXpWeights(): Promise<void> {
    await this.pool.query(`UPDATE xp_config SET value = 0.45 WHERE key = 'steps_weight'`);
    await this.pool.query(`UPDATE xp_config SET value = 0.35 WHERE key = 'ingredients_weight'`);
    await this.pool.query(`UPDATE xp_config SET value = 0.2 WHERE key = 'cook_minutes_weight'`);
    await this.pool.query(`UPDATE xp_config SET value = 10 WHERE key = 'xp_multiplier'`);
  }

  /**
   * Manually call recompute_slot_xp for testing (as superuser)
   */
  async recomputeSlotXp(slotId: number | null = null): Promise<void> {
    await this.pool.query('SELECT recompute_slot_xp($1)', [slotId]);
  }

  /**
   * S1: Try to call recompute_slot_xp as authenticated role (should fail)
   */
  async tryClientCallRecomputeSlotXpAsRole(): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      
      await client.query('SELECT recompute_slot_xp(NULL)');
      
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      const error = e as Error;
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  /**
   * N7: Try to update xp_config value (as superuser) to test CHECK constraints
   */
  async tryUpdateXpConfigValue(key: string, value: number): Promise<{ success: boolean; error?: string }> {
    try {
      await this.pool.query(
        `UPDATE xp_config SET value = $2 WHERE key = $1`,
        [key, value]
      );
      return { success: true };
    } catch (e) {
      const error = e as Error;
      return { success: false, error: error.message };
    }
  }
}
