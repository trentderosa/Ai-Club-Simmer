import pg, { Pool as PoolType } from 'pg';

const { Pool } = pg;

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

  async dropAllTables(): Promise<void> {
    await this.pool.query(`
      DROP TABLE IF EXISTS xp_events CASCADE;
      DROP TABLE IF EXISTS check_ins CASCADE;
      DROP TABLE IF EXISTS user_recipes CASCADE;
      DROP TABLE IF EXISTS user_slot_completions CASCADE;
      DROP TABLE IF EXISTS profiles CASCADE;
      DROP TABLE IF EXISTS path_slots CASCADE;
      DROP TABLE IF EXISTS xp_config CASCADE;
      DROP FUNCTION IF EXISTS award_slot_xp(UUID) CASCADE;
      DROP FUNCTION IF EXISTS award_slot_xp(UUID, UUID, INTEGER) CASCADE;
      DROP FUNCTION IF EXISTS get_user_total_xp() CASCADE;
      DROP FUNCTION IF EXISTS get_user_total_xp(UUID) CASCADE;
      DROP FUNCTION IF EXISTS update_updated_at CASCADE;
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
   * Award XP for a check-in. The new function signature takes only check_in_id
   * and derives user_id and slot_id from the check_in row.
   * 
   * For testing, we simulate auth.uid() by setting a session variable.
   */
  async awardSlotXp(checkInId: string, asUserId?: string): Promise<XpAwardResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      if (asUserId) {
        await client.query(
          `SELECT set_config('request.jwt.claim.sub', $1, true)`,
          [asUserId]
        );
      }
      
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

  async tryClientInsertXpEvent(
    userId: string,
    checkInId: string,
    slotId: number,
    xpAmount: number
  ): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO xp_events (user_id, check_in_id, slot_id, xp_awarded, is_first_completion)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, checkInId, slotId, xpAmount]
      );
      return true;
    } catch {
      return false;
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
}
