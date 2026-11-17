import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * 20261117140000_dish_photos.sql
 *
 * dish_photos is a server-only cache (RLS on, no client policies), like
 * technique_videos. Clients must not read or write it. photo_json on
 * user_generated_recipes is readable by the owner the same way video_ids is.
 */
describe('dish photo cache grants and photo_json', () => {
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
    user = await db.createTestUser(`test-photo-${stamp}@example.com`);
    await db.createProfile(user.id);
  });

  async function asUser<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function asRole<T = Record<string, unknown>>(role: 'anon' | 'service_role', sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  it('clients cannot see or write the dish photo cache', async () => {
    await expect(asUser(user.id, 'SELECT * FROM dish_photos')).rejects.toThrow(/permission denied/);
    await expect(asRole('anon', 'SELECT * FROM dish_photos')).rejects.toThrow(/permission denied/);
    await expect(
      asUser(
        user.id,
        `INSERT INTO dish_photos (normalized_dish_name, image_url, author, license, license_url, source_url)
         VALUES ('pad thai', NULL, NULL, NULL, NULL, NULL)`
      )
    ).rejects.toThrow(/permission denied/);
  });

  it('the table accepts a found photo and a genuine miss', async () => {
    await db.getPool().query(
      `INSERT INTO dish_photos (normalized_dish_name, image_url, author, license, license_url, source_url)
       VALUES (
         'pad thai',
         'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
         'Jane Cook',
         'CC BY-SA 4.0',
         'https://creativecommons.org/licenses/by-sa/4.0/',
         'https://commons.wikimedia.org/wiki/File:Example.jpg'
       )`
    );
    await db.getPool().query(
      `INSERT INTO dish_photos (normalized_dish_name)
       VALUES ('invisible stew')`
    );
    const rows = await db.getPool().query(
      'SELECT normalized_dish_name, image_url FROM dish_photos ORDER BY normalized_dish_name'
    );
    expect(rows.rows).toEqual([
      { normalized_dish_name: 'invisible stew', image_url: null },
      { normalized_dish_name: 'pad thai', image_url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg' },
    ]);
  });

  it('rejects a half-filled cache row', async () => {
    await expect(
      db.getPool().query(
        `INSERT INTO dish_photos (normalized_dish_name, image_url)
         VALUES ('pad thai', 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg')`
      )
    ).rejects.toThrow(/dish_photos_photo_shape/);
  });
});
