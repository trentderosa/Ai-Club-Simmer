import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestDatabase, TestUser } from './db';

/**
 * 20261126120000_personalized_path_dishes.sql
 *
 * Slots (techniques) stay fixed; the dish per slot is chosen from the curated
 * dish_catalog by personalize_my_path(), filtered by dietary needs and scored
 * by cuisines / meal types. Started slots never change.
 */

const NEEDS = [
  'vegetarian', 'vegan', 'no_pork', 'no_beef', 'no_poultry', 'no_fish', 'no_shellfish',
  'dairy_free', 'gluten_free', 'nut_free', 'egg_free', 'no_mushrooms', 'no_spicy',
];
const MEAT = ['pork', 'beef', 'lamb', 'poultry', 'fish', 'shellfish'];

describe('personalized path dishes', () => {
  let db: TestDatabase;
  let user: TestUser;
  let other: TestUser;

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
    user = await db.createTestUser(`test-pathdb-${stamp}@example.com`);
    other = await db.createTestUser(`test-pathdb-other-${stamp}@example.com`);
    await db.createProfile(user.id);
    await db.createProfile(other.id);
  });

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await db.getPool().query(sql, params);
    return result.rows as T[];
  }

  async function setPrefs(
    userId: string,
    prefs: { cuisines?: string[]; meal_types?: string[]; dietary_needs?: string[] }
  ): Promise<void> {
    await q(
      `UPDATE profiles SET cuisines = $2, meal_types = $3, dietary_needs = $4 WHERE id = $1`,
      [userId, prefs.cuisines ?? [], prefs.meal_types ?? [], prefs.dietary_needs ?? []]
    );
  }

  /** Run a query as an authenticated client (RLS + grants apply). */
  async function asUser<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      if (userId) {
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      }
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

  async function personalize(userId: string): Promise<{ slot_id: number; dish_name: string }[]> {
    // Tests call this many times per user; reset the hourly limit (tested separately).
    await q('DELETE FROM personalize_path_hits WHERE user_id = $1', [userId]);
    return asUser(userId, 'SELECT * FROM personalize_my_path()');
  }

  async function containsOf(dishName: string, slotId: number): Promise<string[]> {
    const rows = await q<{ contains: string[] }>(
      'SELECT contains FROM dish_catalog WHERE slot_id = $1 AND dish_name = $2',
      [slotId, dishName]
    );
    return rows[0].contains;
  }

  describe('dish_catalog', () => {
    it('has 80 rows, 8 per slot, including each canonical dish', async () => {
      const total = await q<{ n: string }>('SELECT count(*) AS n FROM dish_catalog');
      expect(Number(total[0].n)).toBe(80);

      const perSlot = await q<{ slot_id: number; n: string }>(
        'SELECT slot_id, count(*) AS n FROM dish_catalog GROUP BY slot_id ORDER BY slot_id'
      );
      expect(perSlot).toHaveLength(10);
      for (const row of perSlot) expect(Number(row.n)).toBe(8);

      const missing = await q(
        `SELECT s.id FROM path_slots s
         WHERE NOT EXISTS (SELECT 1 FROM dish_catalog d WHERE d.slot_id = s.id AND d.dish_name = s.dish_name)`
      );
      expect(missing).toEqual([]);
    });

    it('only uses valid cuisines, meal types and contains tags, with sane names', async () => {
      const bad = await q(
        `SELECT id FROM dish_catalog
         WHERE NOT (cuisines <@ ARRAY['mexican','italian','chinese','japanese','korean','thai','indian','mediterranean','middle_eastern','american']::text[])
            OR NOT (meal_types <@ ARRAY['quick_weeknight','meal_prep','breakfast','date_night','comfort']::text[])
            OR NOT (contains <@ ARRAY['pork','beef','lamb','poultry','fish','shellfish','dairy','gluten','nuts','egg','mushrooms','spicy']::text[])
            OR cardinality(cuisines) = 0 OR cardinality(meal_types) = 0
            OR char_length(dish_name) NOT BETWEEN 2 AND 60`
      );
      expect(bad).toEqual([]);
    });

    it('rejects an unknown contains tag and a duplicate dish name in a slot', async () => {
      await expect(
        q(`INSERT INTO dish_catalog (slot_id, dish_name, contains) VALUES (1, 'Bad Tag Dish', '{kryptonite}')`)
      ).rejects.toThrow(/dish_catalog_contains_valid/);
      await expect(
        q(`INSERT INTO dish_catalog (slot_id, dish_name) SELECT slot_id, upper(dish_name) FROM dish_catalog LIMIT 1`)
      ).rejects.toThrow(/dish_catalog_slot_name_key/);
    });

    it.each(NEEDS)('every slot has a dish compatible with %s', async (need) => {
      const rows = await q<{ slot_id: number; n: string }>(
        `SELECT s.id AS slot_id,
                count(d.id) FILTER (WHERE NOT (d.contains && excluded_contains(ARRAY[$1]::text[]))) AS n
         FROM path_slots s LEFT JOIN dish_catalog d ON d.slot_id = s.id
         GROUP BY s.id ORDER BY s.id`,
        [need]
      );
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(Number(row.n), `slot ${row.slot_id} has no ${need} dish`).toBeGreaterThan(0);
      }
    });

    it('every slot has a dish compatible with vegan + gluten_free + nut_free together', async () => {
      const rows = await q<{ slot_id: number; n: string }>(
        `SELECT s.id AS slot_id,
                count(d.id) FILTER (WHERE NOT (d.contains && excluded_contains(ARRAY['vegan','gluten_free','nut_free']))) AS n
         FROM path_slots s LEFT JOIN dish_catalog d ON d.slot_id = s.id
         GROUP BY s.id ORDER BY s.id`
      );
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(Number(row.n), `slot ${row.slot_id} has no vegan+gf+nf dish`).toBeGreaterThan(0);
      }
    });

    it('is readable by authenticated, hidden from anon, and not writable by clients', async () => {
      const rows = await asUser(user.id, 'SELECT count(*)::int AS n FROM dish_catalog');
      expect(rows[0].n).toBe(80);

      expect(await q<{ ok: boolean }>(`SELECT has_table_privilege('anon', 'public.dish_catalog', 'SELECT') AS ok`)).toEqual([{ ok: false }]);
      for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(
          await q<{ ok: boolean }>(`SELECT has_table_privilege('authenticated', 'public.dish_catalog', '${priv}') AS ok`)
        ).toEqual([{ ok: false }]);
      }
      await expect(
        asUser(user.id, `INSERT INTO dish_catalog (slot_id, dish_name) VALUES (1, 'Client Dish')`)
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('excluded_contains', () => {
    const sorted = async (needs: string[]) =>
      (await q<{ r: string[] }>('SELECT excluded_contains($1::text[]) AS r', [needs]))[0].r;

    it('maps vegetarian and vegan', async () => {
      expect(await sorted(['vegetarian'])).toEqual(['beef', 'fish', 'lamb', 'pork', 'poultry', 'shellfish']);
      expect(await sorted(['vegan'])).toEqual(['beef', 'dairy', 'egg', 'fish', 'lamb', 'pork', 'poultry', 'shellfish']);
    });

    it('is not executable by anon', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'excluded_contains(text[])')).toBe(false);
    });

    it('maps each single need', async () => {
      const expected: Record<string, string> = {
        no_pork: 'pork', no_beef: 'beef', no_poultry: 'poultry', no_fish: 'fish', no_shellfish: 'shellfish',
        dairy_free: 'dairy', gluten_free: 'gluten', nut_free: 'nuts', egg_free: 'egg',
        no_mushrooms: 'mushrooms', no_spicy: 'spicy',
      };
      for (const [need, tag] of Object.entries(expected)) {
        expect(await sorted([need])).toEqual([tag]);
      }
    });

    it('combines needs, and handles empty and null input', async () => {
      expect(await sorted(['vegetarian', 'dairy_free', 'dairy_free'])).toEqual(
        ['beef', 'dairy', 'fish', 'lamb', 'pork', 'poultry', 'shellfish']
      );
      expect(await sorted([])).toEqual([]);
      const nul = await q<{ r: string[] }>('SELECT excluded_contains(NULL) AS r');
      expect(nul[0].r).toEqual([]);
    });
  });

  describe('profiles preference columns', () => {
    it('default to empty arrays', async () => {
      const rows = await q<{ cuisines: string[]; meal_types: string[]; dietary_needs: string[] }>(
        'SELECT cuisines, meal_types, dietary_needs FROM profiles WHERE id = $1',
        [user.id]
      );
      expect(rows[0]).toEqual({ cuisines: [], meal_types: [], dietary_needs: [] });
    });

    it('reject unknown values and oversized arrays', async () => {
      await expect(setPrefs(user.id, { cuisines: ['martian'] })).rejects.toThrow(/profiles_cuisines_valid/);
      await expect(setPrefs(user.id, { meal_types: ['midnight_snack'] })).rejects.toThrow(/profiles_meal_types_valid/);
      await expect(setPrefs(user.id, { dietary_needs: ['carnivore'] })).rejects.toThrow(/profiles_dietary_needs_valid/);
      await expect(
        setPrefs(user.id, { meal_types: Array(6).fill('comfort') })
      ).rejects.toThrow(/profiles_meal_types_valid/);
    });

    it('own-row update still works for an authenticated user', async () => {
      await asUser(user.id, `UPDATE profiles SET cuisines = '{thai,korean}', dietary_needs = '{vegan}' WHERE id = $1`, [user.id]);
      const rows = await q<{ cuisines: string[]; dietary_needs: string[] }>(
        'SELECT cuisines, dietary_needs FROM profiles WHERE id = $1',
        [user.id]
      );
      expect(rows[0]).toEqual({ cuisines: ['thai', 'korean'], dietary_needs: ['vegan'] });
    });
  });

  describe('personalize_my_path', () => {
    it('returns one dish per slot, from the catalog', async () => {
      const result = await personalize(user.id);
      expect(result).toHaveLength(10);
      expect(result.map((r) => r.slot_id)).toEqual((await q<{ id: number }>('SELECT id FROM path_slots ORDER BY slot_order')).map((r) => r.id));
      for (const r of result) {
        const hit = await q('SELECT 1 FROM dish_catalog WHERE slot_id = $1 AND dish_name = $2', [r.slot_id, r.dish_name]);
        expect(hit).toHaveLength(1);
      }
      const stored = await q<{ n: string }>('SELECT count(*) AS n FROM user_path_dishes WHERE user_id = $1', [user.id]);
      expect(Number(stored[0].n)).toBe(10);
    });

    it('never gives a vegetarian meat, fish or shellfish in any slot', async () => {
      await setPrefs(user.id, { dietary_needs: ['vegetarian'], cuisines: ['american', 'mexican'] });
      for (const r of await personalize(user.id)) {
        const contains = await containsOf(r.dish_name, r.slot_id);
        expect(contains.filter((c) => MEAT.includes(c)), `${r.dish_name} (slot ${r.slot_id})`).toEqual([]);
      }
    });

    it('gives vegan + gluten_free users dishes without dairy, egg, gluten or meat', async () => {
      await setPrefs(user.id, { dietary_needs: ['vegan', 'gluten_free'] });
      const banned = [...MEAT, 'dairy', 'egg', 'gluten'];
      for (const r of await personalize(user.id)) {
        const contains = await containsOf(r.dish_name, r.slot_id);
        expect(contains.filter((c) => banned.includes(c)), `${r.dish_name} (slot ${r.slot_id})`).toEqual([]);
      }
    });

    it('respects every single restriction in every slot', async () => {
      const map: Record<string, string[]> = {
        no_pork: ['pork'], no_beef: ['beef'], no_poultry: ['poultry'], no_fish: ['fish'],
        no_shellfish: ['shellfish'], dairy_free: ['dairy'], gluten_free: ['gluten'], nut_free: ['nuts'],
        egg_free: ['egg'], no_mushrooms: ['mushrooms'], no_spicy: ['spicy'],
      };
      for (const [need, tags] of Object.entries(map)) {
        await setPrefs(user.id, { dietary_needs: [need] });
        for (const r of await personalize(user.id)) {
          const contains = await containsOf(r.dish_name, r.slot_id);
          expect(contains.filter((c) => tags.includes(c)), `${need}: ${r.dish_name}`).toEqual([]);
        }
      }
    });

    it('prefers dishes matching the user cuisines', async () => {
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const result = await personalize(user.id);
      const slotsWithMexican = await q<{ slot_id: number }>(
        `SELECT DISTINCT slot_id FROM dish_catalog WHERE 'mexican' = ANY(cuisines)`
      );
      expect(slotsWithMexican.length).toBeGreaterThan(5);
      for (const { slot_id } of slotsWithMexican) {
        const picked = result.find((r) => r.slot_id === slot_id)!;
        const cuisines = await q<{ cuisines: string[] }>(
          'SELECT cuisines FROM dish_catalog WHERE slot_id = $1 AND dish_name = $2',
          [slot_id, picked.dish_name]
        );
        expect(cuisines[0].cuisines, `slot ${slot_id}: ${picked.dish_name}`).toContain('mexican');
      }
    });

    it('scores a cuisine match above a meal-type match', async () => {
      // Slot 3: Cold Soba Noodles is japanese + meal_prep; Mac and Cheese is american + comfort only.
      await setPrefs(user.id, { cuisines: ['japanese'], meal_types: ['comfort'] });
      const result = await personalize(user.id);
      const slot3 = (await q<{ id: number }>('SELECT id FROM path_slots WHERE slot_order = 3'))[0].id;
      expect(result.find((r) => r.slot_id === slot3)!.dish_name).toBe('Cold Soba Noodles');
    });

    it('gives a user with no preferences exactly the canonical dishes', async () => {
      const result = await personalize(user.id);
      const canonical = await q<{ id: number; dish_name: string }>('SELECT id, dish_name FROM path_slots ORDER BY slot_order');
      expect(result).toEqual(canonical.map((c) => ({ slot_id: c.id, dish_name: c.dish_name })));
    });

    it('gives a vegetarian with no cuisines the canonical dish where compatible, else a vegetarian one', async () => {
      await setPrefs(user.id, { dietary_needs: ['vegetarian'] });
      const result = await personalize(user.id);
      const canonical = await q<{ id: number; dish_name: string }>('SELECT id, dish_name FROM path_slots ORDER BY slot_order');
      let swapped = 0;
      for (const c of canonical) {
        const got = result.find((r) => r.slot_id === c.id)!.dish_name;
        const canonicalContains = await containsOf(c.dish_name, c.id);
        if (canonicalContains.some((t) => MEAT.includes(t))) {
          expect(got).not.toBe(c.dish_name);
          expect((await containsOf(got, c.id)).filter((t) => MEAT.includes(t))).toEqual([]);
          swapped++;
        } else {
          expect(got).toBe(c.dish_name);
        }
      }
      expect(swapped).toBeGreaterThanOrEqual(2); // slots 8 and 10 at least
    });

    it('lets preference scoring beat the canonical dish', async () => {
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const slot1 = await db.getSlotId(1);
      const result = await personalize(user.id);
      expect(result.find((r) => r.slot_id === slot1)!.dish_name).toBe('Pico de Gallo');
    });

    it('is deterministic for the same user and preferences', async () => {
      await setPrefs(user.id, { cuisines: ['italian'], meal_types: ['quick_weeknight'] });
      const first = await personalize(user.id);
      const second = await personalize(user.id);
      expect(second).toEqual(first);
    });

    it('can differ between users with identical preferences (tie-break)', async () => {
      // Meal-type-only preference: the canonical dishes have no date_night tag, so
      // several non-canonical dishes tie at the top score in many slots.
      const results = new Set<string>();
      const ids: TestUser[] = [user];
      for (let i = 0; i < 8; i++) {
        const u = await db.createTestUser(`test-pathdb-many-${i}-${Date.now()}@example.com`);
        await db.createProfile(u.id);
        ids.push(u);
      }
      for (const u of ids) {
        await setPrefs(u.id, { meal_types: ['date_night'] });
        results.add(JSON.stringify(await personalize(u.id)));
      }
      expect(results.size).toBeGreaterThan(1);
    });

    it('does not change a slot the user has started (check-in), but changes unstarted slots', async () => {
      const slot1 = await db.getSlotId(1);
      const slot2 = await db.getSlotId(2);
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const before = await personalize(user.id);
      const recipe1 = await db.createUserRecipe(user.id, slot1);
      await db.createUserRecipe(user.id, slot2);
      await db.createCheckIn(user.id, recipe1, slot1);

      await setPrefs(user.id, { cuisines: ['italian'] });
      const after = await personalize(user.id);

      expect(after.find((r) => r.slot_id === slot1)!.dish_name).toBe(before.find((r) => r.slot_id === slot1)!.dish_name);
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1 AND slot_id = $2', [user.id, slot1])).toHaveLength(1);

      const changed = after.find((r) => r.slot_id === slot2)!.dish_name !== before.find((r) => r.slot_id === slot2)!.dish_name;
      expect(changed).toBe(true);
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1 AND slot_id = $2', [user.id, slot2])).toHaveLength(0);
    });

    it('does not change a slot with a completion row or a mastery session', async () => {
      const slot3 = await db.getSlotId(3);
      const slot10 = await db.getSlotId(10);
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const before = await personalize(user.id);

      await q('INSERT INTO user_slot_completions (user_id, slot_id) VALUES ($1, $2)', [user.id, slot3]);
      const recipe10 = await db.createUserRecipe(user.id, slot10);
      await q(
        `INSERT INTO mastery_sessions (user_id, user_recipe_id, slot_id, hidden_step_indices) VALUES ($1, $2, $3, '{0,1}')`,
        [user.id, recipe10, slot10]
      );

      await setPrefs(user.id, { cuisines: ['indian'], dietary_needs: ['vegan'] });
      const after = await personalize(user.id);
      for (const s of [slot3, slot10]) {
        expect(after.find((r) => r.slot_id === s)!.dish_name).toBe(before.find((r) => r.slot_id === s)!.dish_name);
      }
    });

    it('keeps the user_recipes row when the chosen dish does not change', async () => {
      const slot2 = await db.getSlotId(2);
      await setPrefs(user.id, { cuisines: ['indian'] });
      await personalize(user.id);
      await db.createUserRecipe(user.id, slot2);
      await personalize(user.id);
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1 AND slot_id = $2', [user.id, slot2])).toHaveLength(1);
    });

    it('falls back to the canonical dish when no catalog dish fits', async () => {
      await personalize(user.id);
      // Impossible for slot 10 once every dish is excluded: simulate by tagging all of its dishes with pork.
      const slot10 = await db.getSlotId(10);
      const tagged = await q<{ id: string }>(
        `UPDATE dish_catalog SET contains = array_append(contains, 'pork') WHERE slot_id = $1 AND NOT ('pork' = ANY(contains)) RETURNING id`,
        [slot10]
      );
      try {
        await setPrefs(user.id, { dietary_needs: ['no_pork'] });
        const result = await personalize(user.id);
        const canonical = (await q<{ dish_name: string }>('SELECT dish_name FROM path_slots WHERE id = $1', [slot10]))[0].dish_name;
        expect(result.find((r) => r.slot_id === slot10)!.dish_name).toBe(canonical);
        expect(await q('SELECT 1 FROM user_path_dishes WHERE user_id = $1 AND slot_id = $2', [user.id, slot10])).toHaveLength(0);
      } finally {
        await q(
          `UPDATE dish_catalog SET contains = array_remove(contains, 'pork') WHERE id = ANY($1::bigint[])`,
          [tagged.map((t) => t.id)]
        );
      }
    });

    it('works for a user with no profile row (defaults)', async () => {
      const noProfile = await db.createTestUser(`test-pathdb-noprofile-${Date.now()}@example.com`);
      const result = await personalize(noProfile.id);
      expect(result).toHaveLength(10);
    });

    it('is not executable by anon and errors without auth.uid()', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'personalize_my_path()')).toBe(false);
      await expect(
        (async () => {
          const client = await db.getPool().connect();
          try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE anon');
            await client.query('SELECT * FROM personalize_my_path()');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        })()
      ).rejects.toThrow(/permission denied/i);
      await expect(asUser(null, 'SELECT * FROM personalize_my_path()')).rejects.toThrow(/Authentication required/);
    });
  });

  describe('personalize_my_path rate limit', () => {
    it('allows 10 calls per hour, then raises PERSONALIZE_RATE_LIMITED and changes nothing', async () => {
      await q('DELETE FROM personalize_path_hits WHERE user_id = $1', [user.id]);
      await setPrefs(user.id, { cuisines: ['mexican'] });
      for (let i = 0; i < 10; i++) await asUser(user.id, 'SELECT * FROM personalize_my_path()');
      const before = await q('SELECT slot_id, dish_name FROM user_path_dishes WHERE user_id = $1 ORDER BY slot_id', [user.id]);

      await setPrefs(user.id, { cuisines: ['korean'], dietary_needs: ['vegan'] });
      await expect(asUser(user.id, 'SELECT * FROM personalize_my_path()')).rejects.toThrow(/PERSONALIZE_RATE_LIMITED/);
      const after = await q('SELECT slot_id, dish_name FROM user_path_dishes WHERE user_id = $1 ORDER BY slot_id', [user.id]);
      expect(after).toEqual(before);

      // Another user is unaffected.
      await expect(personalize(other.id)).resolves.toHaveLength(10);

      // Old hits fall out of the rolling hour.
      await q(`UPDATE personalize_path_hits SET occurred_at = NOW() - INTERVAL '61 minutes' WHERE user_id = $1`, [user.id]);
      await expect(asUser(user.id, 'SELECT * FROM personalize_my_path()')).resolves.toHaveLength(10);
    });

    it('keeps the hits table away from clients', async () => {
      await expect(asUser(user.id, 'SELECT * FROM personalize_path_hits')).rejects.toThrow(/permission denied/i);
      await expect(asUser(user.id, 'DELETE FROM personalize_path_hits')).rejects.toThrow(/permission denied/i);
    });
  });

  describe('personalize_my_path concurrency', () => {
    it('skips a slot whose check-in commits while personalize waits on the recipe lock', async () => {
      const slot1 = await db.getSlotId(1);
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const before = (await personalize(user.id)).find((r) => r.slot_id === slot1)!.dish_name;
      const recipe = await db.createUserRecipe(user.id, slot1);
      // New preferences that would change slot 1's dish (and delete its recipe).
      await setPrefs(user.id, { cuisines: ['korean'] });
      await q('DELETE FROM personalize_path_hits WHERE user_id = $1', [user.id]);

      const a = await db.getPool().connect();
      const b = await db.getPool().connect();
      try {
        // A: check-in inserted but not committed (holds a KEY SHARE lock on the recipe).
        await a.query('BEGIN');
        await a.query(
          `INSERT INTO check_ins (user_id, user_recipe_id, slot_id, difficulty_rating) VALUES ($1, $2, $3, 'ok')`,
          [user.id, recipe, slot1]
        );

        // B: personalize as the user; it must block on the slot 1 recipe row.
        await b.query('BEGIN');
        await b.query('SET LOCAL ROLE authenticated');
        await b.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user.id]);
        const running = b.query('SELECT * FROM personalize_my_path()');

        let blocked = false;
        for (let i = 0; i < 50 && !blocked; i++) {
          const w = await q(
            `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%personalize_my_path%' AND pid <> pg_backend_pid()`
          );
          blocked = w.length > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 100));
        }
        expect(blocked, 'personalize_my_path should be waiting on the recipe row lock').toBe(true);

        await a.query('COMMIT');
        await running;
        await b.query('COMMIT');
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        a.release();
        b.release();
      }

      expect(await q('SELECT 1 FROM check_ins WHERE user_id = $1 AND slot_id = $2', [user.id, slot1])).toHaveLength(1);
      expect(await q('SELECT 1 FROM user_recipes WHERE id = $1', [recipe])).toHaveLength(1);
      const now = await q<{ dish_name: string }>('SELECT dish_name FROM user_path_dishes WHERE user_id = $1 AND slot_id = $2', [user.id, slot1]);
      expect(now[0].dish_name).toBe(before);
    });

    it('never deletes a recipe that has a check-in even if the slot looks unstarted', async () => {
      // A recipe with a check-in survives a changed pick (the slot is started, and the DELETE is also guarded).
      const slot2 = await db.getSlotId(2);
      await setPrefs(user.id, { cuisines: ['indian'] });
      await personalize(user.id);
      const recipe = await db.createUserRecipe(user.id, slot2);
      await db.createCheckIn(user.id, recipe, slot2);
      await setPrefs(user.id, { cuisines: ['chinese'] });
      await personalize(user.id);
      expect(await q('SELECT 1 FROM user_recipes WHERE id = $1', [recipe])).toHaveLength(1);
    });
  });

  describe('dietary_needs change invalidates cached recipes', () => {
    it('adding nut_free deletes recipes of unstarted slots only and keeps check-ins', async () => {
      const slot1 = await db.getSlotId(1);
      const slot2 = await db.getSlotId(2);
      const slot3 = await db.getSlotId(3);
      const r1 = await db.createUserRecipe(user.id, slot1);
      await db.createUserRecipe(user.id, slot2);
      await db.createUserRecipe(user.id, slot3);
      const checkIn = await db.createCheckIn(user.id, r1, slot1);
      await q('INSERT INTO user_slot_completions (user_id, slot_id) VALUES ($1, $2)', [user.id, slot3]);

      // Authenticated own-row update (the app path); trigger is SECURITY DEFINER.
      await asUser(user.id, `UPDATE profiles SET dietary_needs = '{nut_free}' WHERE id = $1`, [user.id]);

      const left = await q<{ slot_id: number }>('SELECT slot_id FROM user_recipes WHERE user_id = $1 ORDER BY slot_id', [user.id]);
      expect(left.map((r) => r.slot_id)).toEqual([slot1, slot3].sort((x, y) => x - y));
      expect(await q('SELECT 1 FROM check_ins WHERE id = $1', [checkIn])).toHaveLength(1);
    });

    it('reordering or repeating the same set deletes nothing', async () => {
      await setPrefs(user.id, { dietary_needs: ['nut_free', 'vegan'] });
      const slot2 = await db.getSlotId(2);
      await db.createUserRecipe(user.id, slot2);
      await setPrefs(user.id, { dietary_needs: ['vegan', 'nut_free'] });
      await setPrefs(user.id, { dietary_needs: ['vegan', 'nut_free', 'vegan'] });
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1', [user.id])).toHaveLength(1);
    });

    it('removing a restriction also invalidates; changing other columns does not', async () => {
      const slot2 = await db.getSlotId(2);
      await setPrefs(user.id, { dietary_needs: ['nut_free'] });
      await db.createUserRecipe(user.id, slot2);
      await q(`UPDATE profiles SET cuisines = '{thai}' WHERE id = $1`, [user.id]);
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1', [user.id])).toHaveLength(1);
      await setPrefs(user.id, { dietary_needs: [] });
      expect(await q('SELECT 1 FROM user_recipes WHERE user_id = $1', [user.id])).toHaveLength(0);
    });

    it('keeps a slot with a mastery session', async () => {
      const slot10 = await db.getSlotId(10);
      const recipe = await db.createUserRecipe(user.id, slot10);
      await q(
        `INSERT INTO mastery_sessions (user_id, user_recipe_id, slot_id, hidden_step_indices) VALUES ($1, $2, $3, '{0}')`,
        [user.id, recipe, slot10]
      );
      await setPrefs(user.id, { dietary_needs: ['nut_free'] });
      expect(await q('SELECT 1 FROM user_recipes WHERE id = $1', [recipe])).toHaveLength(1);
    });

    it('lock_unstarted_slot is not executable by clients', async () => {
      expect(await db.hasFunctionPrivilege('anon', 'lock_unstarted_slot(uuid, integer, boolean)')).toBe(false);
      expect(await db.hasFunctionPrivilege('authenticated', 'lock_unstarted_slot(uuid, integer, boolean)')).toBe(false);
    });
  });

  describe('user_path_dishes RLS', () => {
    it('lets a user read only their own rows', async () => {
      await personalize(user.id);
      await personalize(other.id);
      const mine = await asUser<{ user_id: string }>(user.id, 'SELECT user_id FROM user_path_dishes');
      expect(mine).toHaveLength(10);
      expect(mine.every((r) => r.user_id === user.id)).toBe(true);
      const theirs = await asUser(user.id, 'SELECT * FROM user_path_dishes WHERE user_id = $1', [other.id]);
      expect(theirs).toEqual([]);
    });

    it('blocks direct INSERT, UPDATE and DELETE by clients', async () => {
      await personalize(user.id);
      const dishId = (await q<{ id: string }>('SELECT id FROM dish_catalog WHERE slot_id = 1 LIMIT 1'))[0].id;
      await expect(
        asUser(other.id, `INSERT INTO user_path_dishes (user_id, slot_id, catalog_dish_id, dish_name) VALUES ($1, 1, $2, 'x')`, [other.id, dishId])
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asUser(user.id, `UPDATE user_path_dishes SET dish_name = 'Hacked' WHERE user_id = $1`, [user.id])
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asUser(user.id, 'DELETE FROM user_path_dishes WHERE user_id = $1', [user.id])
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('plan and recipe book RPCs', () => {
    it('get_plan_for_user returns the personalized dish, canonical when no row', async () => {
      const slot1 = await db.getSlotId(1);
      const canonical = await q<{ id: number; dish_name: string }>('SELECT id, dish_name FROM path_slots ORDER BY slot_order');

      let plan = await q<{ slot_id: number; dish_name: string }>('SELECT * FROM get_plan_for_user($1)', [user.id]);
      expect(plan.map((p) => p.dish_name)).toEqual(canonical.map((c) => c.dish_name));

      await setPrefs(user.id, { cuisines: ['mexican'] });
      const picked = await personalize(user.id);
      plan = await q('SELECT * FROM get_plan_for_user($1)', [user.id]);
      expect(plan.map((p) => p.dish_name)).toEqual(picked.map((p) => p.dish_name));

      const mine = await asUser<{ slot_id: number; dish_name: string }>(user.id, 'SELECT * FROM get_my_plan()');
      expect(mine.find((p) => p.slot_id === slot1)!.dish_name).toBe(picked.find((p) => p.slot_id === slot1)!.dish_name);

      // Another user without rows still sees canonical names.
      const otherPlan = await q<{ dish_name: string }>('SELECT * FROM get_plan_for_user($1)', [other.id]);
      expect(otherPlan.map((p) => p.dish_name)).toEqual(canonical.map((c) => c.dish_name));
    });

    it('get_plan_summary_for_user is unchanged in shape and still works', async () => {
      await personalize(user.id);
      const rows = await q<{ total_slots: number; suggested_sessions_per_week: number }>('SELECT * FROM get_plan_summary_for_user($1)', [user.id]);
      expect(rows[0].total_slots).toBe(10);
      expect(rows[0].suggested_sessions_per_week).toBeGreaterThan(0);
    });

    it('get_recipe_book_v2_for_user returns the personalized dish name for a cooked slot', async () => {
      const slot1 = await db.getSlotId(1);
      await setPrefs(user.id, { cuisines: ['mexican'] });
      const picked = (await personalize(user.id)).find((p) => p.slot_id === slot1)!.dish_name;
      const recipe = await db.createUserRecipe(user.id, slot1, { title: '' });
      await q(`UPDATE user_recipes SET recipe_json = '{}'::jsonb WHERE id = $1`, [recipe]);
      await db.createCheckIn(user.id, recipe, slot1);

      const book = await q<{ dish_name: string; recipe_title: string; kind: string }>('SELECT * FROM get_recipe_book_v2_for_user($1)', [user.id]);
      expect(book).toHaveLength(1);
      expect(book[0].dish_name).toBe(picked);
      expect(book[0].recipe_title).toBe(picked);

      const canonical = await q<{ dish_name: string }>('SELECT dish_name FROM path_slots WHERE id = $1', [slot1]);
      expect(picked).not.toBe(canonical[0].dish_name);
    });

    it('get_recipe_book_v2_for_user returns the canonical name when there is no pick', async () => {
      const slot1 = await db.getSlotId(1);
      const recipe = await db.createUserRecipe(user.id, slot1);
      await db.createCheckIn(user.id, recipe, slot1);
      const book = await q<{ dish_name: string }>('SELECT * FROM get_recipe_book_v2_for_user($1)', [user.id]);
      const canonical = await q<{ dish_name: string }>('SELECT dish_name FROM path_slots WHERE id = $1', [slot1]);
      expect(book[0].dish_name).toBe(canonical[0].dish_name);
    });
  });
});
