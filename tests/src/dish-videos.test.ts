import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * 20261117201646_dish_videos.sql
 *
 * dish_videos is a server-only cache (RLS on, no client policies), like
 * technique_videos and dish_photos.
 */
describe('dish video cache grants', () => {
  let db: TestDatabase;
  let user: TestUser;

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
    user = await db.createTestUser(`test-dish-video-${stamp}@example.com`);
    await db.createProfile(user.id);
  });

  async function asUser(userId: string, sql: string): Promise<void> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query(sql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function asRole(role: 'anon' | 'service_role', sql: string): Promise<unknown[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      const result = await client.query(sql);
      await client.query('COMMIT');
      return result.rows;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  it('clients cannot read or write dish_videos, and the service role can store up to 3', async () => {
    await expect(asUser(user.id, 'SELECT * FROM dish_videos')).rejects.toThrow(/permission denied/);
    await expect(asRole('anon', 'SELECT * FROM dish_videos')).rejects.toThrow(/permission denied/);
    await expect(
      asUser(
        user.id,
        `INSERT INTO dish_videos (normalized_dish_name, search_query, videos_json)
         VALUES ('pho', 'pho recipe', '[]'::jsonb)`
      )
    ).rejects.toThrow(/permission denied/);

    await asRole(
      'service_role',
      `INSERT INTO dish_videos (normalized_dish_name, search_query, videos_json)
       VALUES ('pho', 'pho recipe', '[{"videoId":"phohigh001","title":"Authentic pho recipe"}]'::jsonb)`
    );
    const rows = await db.getPool().query(
      `SELECT normalized_dish_name, search_query, videos_json FROM dish_videos`
    );
    expect(rows.rows).toEqual([
      {
        normalized_dish_name: 'pho',
        search_query: 'pho recipe',
        videos_json: [{ videoId: 'phohigh001', title: 'Authentic pho recipe' }],
      },
    ]);

    await expect(
      db.getPool().query(
        `INSERT INTO dish_videos (normalized_dish_name, search_query, videos_json)
         VALUES (
           'too many',
           'too many recipe',
           '[{"videoId":"a"},{"videoId":"b"},{"videoId":"c"},{"videoId":"d"}]'::jsonb
         )`
      )
    ).rejects.toThrow(/dish_videos_json_size/);
  });
});
