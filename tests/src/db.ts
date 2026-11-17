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

export interface RunMigrationsOptions {
  /**
   * When true (default), stub public.rls_auto_enable() before migrations so
   * privilege/runtime tests can exercise EXECUTE denials. Set false to prove
   * the lockdown migration applies on a fresh DB that lacks that function.
   */
  stubRlsAutoEnable?: boolean;
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
   * Shared Supabase-like role bootstrap (N1: single helper for stubs + setupRoles).
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

      -- Match Supabase: INVOKER RPCs such as get_user_total_xp() call auth.uid()
      -- and need USAGE on schema auth. RLS policy expressions run as the table
      -- owner, so they already work without this grant.
      DO $auth_grants$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
          EXECUTE 'GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role';
        END IF;
        IF to_regprocedure('auth.uid()') IS NOT NULL THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, service_role';
        END IF;
        IF to_regprocedure('auth.role()') IS NOT NULL THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, anon, service_role';
        END IF;
      END
      $auth_grants$;
    `);
  }

  /**
   * Stub public.rls_auto_enable() for grant/deny tests only.
   *
   * N2: Prod's helper may be RETURNS event_trigger (ensure_rls event trigger).
   * This stub is RETURNS void SECURITY DEFINER so we can call it via SELECT and
   * assert EXECUTE ACL. We are testing grants, not the prod function body/shape.
   * GRANT mirrors Supabase public-schema default privileges: EXECUTE to PUBLIC
   * and a direct grant to anon, authenticated, and service_role. Confirm prod
   * with: \\df+ public.rls_auto_enable
   */
  async ensureRlsAutoEnableStub(): Promise<void> {
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION public.rls_auto_enable()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
      BEGIN
        NULL;
      END;
      $fn$;
      GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC, anon, authenticated, service_role;
    `);
  }

  /**
   * Create Supabase-like roles and optionally stub rls_auto_enable.
   * Must run after dropAllTables and before migrations that GRANT TO service_role.
   */
  async ensurePlatformStubs(options: RunMigrationsOptions = {}): Promise<void> {
    const stubRlsAutoEnable = options.stubRlsAutoEnable ?? true;
    await this.ensureSupabaseRoles();
    if (stubRlsAutoEnable) {
      await this.ensureRlsAutoEnableStub();
    }
  }

  /**
   * N6: Run all migrations from supabase/migrations/ in sorted order.
   * This ensures future migrations are automatically included.
   */
  async runAllMigrations(options: RunMigrationsOptions = {}): Promise<void> {
    const stubRlsAutoEnable = options.stubRlsAutoEnable ?? true;
    await this.ensurePlatformStubs({ stubRlsAutoEnable });

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
   * Whether public.rls_auto_enable() currently exists.
   */
  async hasRlsAutoEnable(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT to_regprocedure('public.rls_auto_enable()') IS NOT NULL AS present`
    );
    return result.rows[0].present === true;
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

      -- 20261115000000_plan_badges_recipe_book.sql: re-assert after broad GRANTs
      REVOKE INSERT, UPDATE, DELETE ON badges FROM anon, authenticated;
      REVOKE ALL ON technique_videos FROM anon, authenticated;
      REVOKE UPDATE, DELETE ON check_ins FROM anon, authenticated;

      -- 20261115180000_cook_anything.sql: re-assert after broad GRANTs
      REVOKE INSERT, UPDATE, DELETE ON user_generated_recipes FROM anon, authenticated;
      REVOKE INSERT, UPDATE, DELETE ON user_generated_dish_completions FROM anon, authenticated;
      REVOKE INSERT, UPDATE, DELETE ON generated_recipe_xp_events FROM anon, authenticated;
      REVOKE INSERT, UPDATE, DELETE ON generated_recipe_check_ins FROM anon, authenticated;
      GRANT SELECT ON generated_recipe_check_ins TO authenticated;
      REVOKE EXECUTE ON FUNCTION public.award_generated_recipe_xp(UUID) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.award_generated_recipe_xp(UUID) TO service_role;

      -- 20261117140000_dish_photos.sql: re-assert after broad GRANTs
      REVOKE ALL ON dish_photos FROM PUBLIC, anon, authenticated;
      GRANT ALL ON dish_photos TO service_role;

      -- 20261117201646_dish_videos.sql: re-assert after broad GRANTs
      REVOKE ALL ON dish_videos FROM PUBLIC, anon, authenticated;
      GRANT ALL ON dish_videos TO service_role;

      -- 20261116000000_mastery_sessions.sql: re-assert after broad GRANTs
      REVOKE ALL ON mastery_sessions FROM PUBLIC, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE ON mastery_sessions TO service_role;
      REVOKE INSERT ON check_ins FROM anon, authenticated;
      REVOKE SELECT ON user_recipes FROM anon, authenticated;
      GRANT SELECT (id, user_id, slot_id, video_ids, created_at) ON user_recipes TO authenticated;
    `);

    // Match migration guard: only revoke when the function exists
    await this.pool.query(`
      DO $$
      BEGIN
        IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
          REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
        END IF;
      END
      $$;
    `);
  }

  async cleanupTestData(): Promise<void> {
    await this.pool.query('DELETE FROM generated_recipe_xp_events');
    await this.pool.query('DELETE FROM generated_recipe_check_ins');
    await this.pool.query('DELETE FROM user_generated_dish_completions');
    await this.pool.query('DELETE FROM user_generated_recipes');
    await this.pool.query('DELETE FROM xp_events');
    await this.pool.query('DELETE FROM check_ins');
    await this.pool.query('DELETE FROM mastery_sessions');
    await this.pool.query('DELETE FROM technique_videos');
    await this.pool.query('DELETE FROM dish_videos');
    await this.pool.query('DELETE FROM dish_photos');
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
  async createUserRecipe(userId: string, slotId: number, recipeJson?: object): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO user_recipes (user_id, slot_id, recipe_json)
       VALUES ($1, $2, COALESCE($3::jsonb, '{"title": "Test Recipe", "steps": []}'::jsonb))
       RETURNING id`,
      [userId, slotId, recipeJson ? JSON.stringify(recipeJson) : null]
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
   * Try to execute rls_auto_enable as a client role.
   */
  async tryRlsAutoEnableAsRole(
    role: ClientRole
  ): Promise<{ success: boolean; error?: string }> {
    assertClientRole(role);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query('SELECT public.rls_auto_enable()');
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
      `SELECT
         COALESCE((SELECT SUM(xp_awarded) FROM xp_events WHERE user_id = $1), 0)
         + COALESCE((SELECT SUM(xp_awarded) FROM generated_recipe_xp_events WHERE user_id = $1), 0)
         AS total`,
      [userId]
    );
    return parseInt(result.rows[0].total);
  }

  async getUserTotalXpViaFunction(userId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      const result = await client.query('SELECT get_user_total_xp() AS total');
      await client.query('COMMIT');
      return parseInt(result.rows[0].total);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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
    await this.pool.query(`UPDATE xp_config SET value = 10 WHERE key = 'freeform_max_steps'`);
    await this.pool.query(`UPDATE xp_config SET value = 12 WHERE key = 'freeform_max_ingredients'`);
    await this.pool.query(`UPDATE xp_config SET value = 45 WHERE key = 'freeform_max_minutes'`);
    await this.pool.query(`UPDATE xp_config SET value = 1 WHERE key = 'freeform_min_steps'`);
    await this.pool.query(`UPDATE xp_config SET value = 1 WHERE key = 'freeform_min_ingredients'`);
    await this.pool.query(`UPDATE xp_config SET value = 1 WHERE key = 'freeform_min_minutes'`);
    await this.pool.query(`UPDATE xp_config SET value = 200 WHERE key = 'freeform_daily_cap'`);
  }

  async createGeneratedRecipe(
    userId: string,
    opts: {
      dishQuery?: string;
      normalizedDishName?: string;
      stepCount: number;
      ingredientCount: number;
      timeEstimateMinutes: number;
      recipeJson?: object;
    }
  ): Promise<{ id: string; xp_value: number; step_count: number; ingredient_count: number; time_estimate_minutes: number }> {
    const dishQuery = opts.dishQuery ?? 'Pad Thai';
    const normalized = opts.normalizedDishName ?? 'pad thai';
    const recipeJson = opts.recipeJson ?? {
      title: dishQuery,
      ingredients: Array.from({ length: Math.max(1, opts.ingredientCount) }, (_, i) => ({
        name: `ingredient ${i + 1}`,
        amount: '1',
      })),
      timeEstimateMinutes: opts.timeEstimateMinutes,
      steps: Array.from({ length: Math.max(1, opts.stepCount) }, (_, i) => ({
        instruction: `Step ${i + 1}`,
        isSafetyStep: false,
      })),
    };
    const result = await this.pool.query(
      `INSERT INTO user_generated_recipes (
         user_id, dish_query, normalized_dish_name, recipe_json,
         step_count, ingredient_count, time_estimate_minutes, xp_value
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 1)
       RETURNING id, xp_value, step_count, ingredient_count, time_estimate_minutes`,
      [
        userId,
        dishQuery,
        normalized,
        JSON.stringify(recipeJson),
        opts.stepCount,
        opts.ingredientCount,
        opts.timeEstimateMinutes,
      ]
    );
    return result.rows[0];
  }

  async createGeneratedCheckIn(
    userId: string,
    generatedRecipeId: string,
    id?: string
  ): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO generated_recipe_check_ins (id, user_id, generated_recipe_id, difficulty_rating)
       VALUES (COALESCE($3, gen_random_uuid()), $1, $2, 'ok')
       RETURNING id`,
      [userId, generatedRecipeId, id ?? null]
    );
    return result.rows[0].id;
  }

  async awardGeneratedRecipeXp(checkInId: string): Promise<XpAwardResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
      const result = await client.query('SELECT * FROM award_generated_recipe_xp($1)', [checkInId]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async tryAwardGeneratedRecipeXpAsRole(
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
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      }
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      await client.query('SELECT * FROM award_generated_recipe_xp($1)', [checkInId]);
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      return { success: false, error: (e as Error).message };
    } finally {
      client.release();
    }
  }

  async getGeneratedRecipeRow(id: string): Promise<{
    step_count: number;
    ingredient_count: number;
    time_estimate_minutes: number;
    xp_value: number;
    recipe_json: unknown;
  }> {
    const result = await this.pool.query(
      `SELECT step_count, ingredient_count, time_estimate_minutes, xp_value, recipe_json
       FROM user_generated_recipes WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  }

  async tryUpdateGeneratedRecipeCounts(
    id: string,
    counts: { stepCount: number; ingredientCount: number; timeEstimateMinutes: number; xpValue: number; recipeJson: object }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE user_generated_recipes
       SET recipe_json = $2::jsonb,
           step_count = $3,
           ingredient_count = $4,
           time_estimate_minutes = $5,
           xp_value = $6
       WHERE id = $1`,
      [id, JSON.stringify(counts.recipeJson), counts.stepCount, counts.ingredientCount, counts.timeEstimateMinutes, counts.xpValue]
    );
  }

  async countGeneratedXpEvents(checkInId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*)::int AS n FROM generated_recipe_xp_events WHERE check_in_id = $1',
      [checkInId]
    );
    return result.rows[0].n;
  }

  async listGeneratedRecipeIdsAsUser(userId: string): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      const rows = await client.query('SELECT id FROM user_generated_recipes');
      await client.query('COMMIT');
      return rows.rows.map((r: { id: string }) => r.id);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async tryInsertGeneratedRecipeAsUser(userId: string): Promise<{ success: boolean; error?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query(
        `INSERT INTO user_generated_recipes (
           user_id, dish_query, normalized_dish_name, recipe_json,
           step_count, ingredient_count, time_estimate_minutes, xp_value
         ) VALUES ($1, 'x', 'x', '{}', 1, 1, 1, 1)`,
        [userId]
      );
      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      return { success: false, error: (e as Error).message };
    } finally {
      client.release();
    }
  }

  async backdateCheckIn(checkInId: string, daysAgo: number): Promise<void> {
    await this.pool.query(
      `UPDATE check_ins SET created_at = NOW() - make_interval(days => $2) WHERE id = $1`,
      [checkInId, daysAgo]
    );
  }

  async backdateGeneratedCheckIn(checkInId: string, daysAgo: number): Promise<void> {
    await this.pool.query(
      `UPDATE generated_recipe_check_ins SET created_at = NOW() - make_interval(days => $2) WHERE id = $1`,
      [checkInId, daysAgo]
    );
  }

  /**
   * SQL twin of the ai-server reconcile scan (ai-server/src/jobs/supabase-reconcile-source.ts).
   * That job runs two PostgREST anti-joins (check_ins with no xp_events, and
   * generated_recipe_check_ins with no generated_recipe_xp_events) and merges
   * them oldest first, at most `limit`. This UNION is the same result.
   */
  async findCheckInsMissingXp(
    from: Date,
    to: Date,
    limit: number
  ): Promise<{ check_in_id: string; slot_id: number | null; created_at: string; kind: 'slot' | 'generated' }[]> {
    const result = await this.pool.query(
      `SELECT c.id AS check_in_id, c.slot_id, c.created_at, 'slot'::text AS kind
         FROM check_ins c
        WHERE NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
          AND c.created_at >= $1
          AND c.created_at <= $2
        UNION ALL
       SELECT g.id, NULL::integer, g.created_at, 'generated'::text
         FROM generated_recipe_check_ins g
        WHERE NOT EXISTS (
          SELECT 1 FROM generated_recipe_xp_events e WHERE e.check_in_id = g.id
        )
          AND g.created_at >= $1
          AND g.created_at <= $2
        ORDER BY created_at ASC, check_in_id ASC
        LIMIT $3`,
      [from, to, limit]
    );
    return result.rows.map((row) => ({
      check_in_id: row.check_in_id,
      slot_id: row.slot_id,
      created_at: new Date(row.created_at).toISOString(),
      kind: row.kind === 'generated' ? 'generated' : 'slot',
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
