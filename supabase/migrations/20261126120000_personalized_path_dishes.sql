-- =============================================================================
-- Simmer - Personalized path dishes (F1 onboarding answers, F2 plan)
-- =============================================================================
-- The 10 technique slots (path_slots) stay fixed: order, technique, XP,
-- badges, mastery and unlocking are all still keyed to the slot. What changes
-- is the DISH a user cooks for each slot. It is chosen from a curated catalog
-- by plain SQL (never by the AI), so diet safety is data-driven:
--
--   1. profiles gains cuisines, meal_types and dietary_needs (fixed lists).
--   2. dish_catalog: 8-9 curated dishes per slot (81 in all), each tagged with cuisines,
--      meal types and what it `contains` (pork, dairy, gluten, ...).
--   3. excluded_contains(): the ONE place that maps a dietary need to the
--      `contains` tags it rules out.
--   4. user_path_dishes: the dish picked for a user + slot (snapshot name).
--   5. personalize_my_path(): picks the dishes for every slot the user has
--      not started. Started slots never change.
--   6. get_plan_for_user and get_recipe_book_v2_for_user return the
--      personalized dish name (canonical name when there is no pick).
--
-- Not changed on purpose: XP functions, xp_value, badges, mastery, and the
-- suggested sessions / weeks logic (still uses the slot's canonical
-- cook_minutes). Badge names are still the canonical dish names.
--
-- This is a NEW migration. Kai applies it to prod only after the PR is merged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles: food preferences (fixed lists, bounded size)
-- No column-level grants exist on profiles; the existing own-row RLS policies
-- and table grants cover the new columns.
-- -----------------------------------------------------------------------------
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS cuisines TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS meal_types TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS dietary_needs TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE profiles
    ADD CONSTRAINT profiles_cuisines_valid CHECK (
        cardinality(cuisines) <= 10
        AND cuisines <@ ARRAY['mexican', 'italian', 'chinese', 'japanese', 'korean',
                              'thai', 'indian', 'mediterranean', 'middle_eastern', 'american']::TEXT[]
    ),
    ADD CONSTRAINT profiles_meal_types_valid CHECK (
        cardinality(meal_types) <= 5
        AND meal_types <@ ARRAY['quick_weeknight', 'meal_prep', 'breakfast', 'date_night', 'comfort']::TEXT[]
    ),
    ADD CONSTRAINT profiles_dietary_needs_valid CHECK (
        cardinality(dietary_needs) <= 13
        AND dietary_needs <@ ARRAY['vegetarian', 'vegan', 'no_pork', 'no_beef', 'no_poultry', 'no_fish',
                                   'no_shellfish', 'dairy_free', 'gluten_free', 'nut_free', 'egg_free',
                                   'no_mushrooms', 'no_spicy']::TEXT[]
    );

-- -----------------------------------------------------------------------------
-- 2. dish_catalog: curated dishes per slot (public content, read-only)
-- Every dish practices the slot's technique at a beginner level using only a
-- stove, pots, pans, oven, sheet pan, knife and cutting board.
-- `contains` describes the STANDARD version of the dish.
-- -----------------------------------------------------------------------------
CREATE TABLE dish_catalog (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    dish_name TEXT NOT NULL CHECK (char_length(dish_name) BETWEEN 2 AND 60),
    cuisines TEXT[] NOT NULL DEFAULT '{}',
    meal_types TEXT[] NOT NULL DEFAULT '{}',
    contains TEXT[] NOT NULL DEFAULT '{}',
    CONSTRAINT dish_catalog_cuisines_valid CHECK (
        cardinality(cuisines) <= 10
        AND cuisines <@ ARRAY['mexican', 'italian', 'chinese', 'japanese', 'korean',
                              'thai', 'indian', 'mediterranean', 'middle_eastern', 'american']::TEXT[]
    ),
    CONSTRAINT dish_catalog_meal_types_valid CHECK (
        cardinality(meal_types) <= 5
        AND meal_types <@ ARRAY['quick_weeknight', 'meal_prep', 'breakfast', 'date_night', 'comfort']::TEXT[]
    ),
    CONSTRAINT dish_catalog_contains_valid CHECK (
        cardinality(contains) <= 12
        AND contains <@ ARRAY['pork', 'beef', 'lamb', 'poultry', 'fish', 'shellfish',
                              'dairy', 'gluten', 'nuts', 'egg', 'mushrooms', 'spicy']::TEXT[]
    )
);

CREATE UNIQUE INDEX dish_catalog_slot_name_key ON dish_catalog (slot_id, lower(dish_name));

ALTER TABLE dish_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view dish catalog"
    ON dish_catalog FOR SELECT
    TO authenticated
    USING (TRUE);

REVOKE ALL ON dish_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON dish_catalog TO authenticated;
GRANT SELECT ON dish_catalog TO service_role;

-- Seed: 81 dishes: 9 for slot 8, 8 for every other slot. A NULL name means "the slot's canonical dish"
-- (taken from path_slots.dish_name so the two can never disagree).
INSERT INTO dish_catalog (slot_id, dish_name, cuisines, meal_types, contains)
SELECT s.id, COALESCE(v.dish_name, s.dish_name), v.cuisines::TEXT[], v.meal_types::TEXT[], v.contains::TEXT[]
FROM (VALUES
    -- Slot 1: Knife skills
    (1, NULL, '{american}', '{quick_weeknight,meal_prep}', '{}'),
    (1, 'Pico de Gallo', '{mexican}', '{quick_weeknight,meal_prep}', '{spicy}'),
    (1, 'Caprese Salad', '{italian}', '{quick_weeknight,date_night}', '{dairy}'),
    (1, 'Kachumber Salad', '{indian}', '{quick_weeknight,meal_prep}', '{spicy}'),
    (1, 'Tabbouleh', '{middle_eastern}', '{meal_prep}', '{gluten}'),
    (1, 'Thai Cucumber Salad', '{thai}', '{quick_weeknight}', '{spicy,nuts}'),
    (1, 'Korean Cucumber Salad', '{korean}', '{quick_weeknight,meal_prep}', '{spicy,gluten}'),
    (1, 'Greek Salad', '{mediterranean}', '{quick_weeknight,date_night}', '{dairy}'),
    -- Slot 2: Heat control
    (2, NULL, '{american}', '{breakfast,quick_weeknight}', '{egg,dairy}'),
    (2, 'Creamy Stovetop Polenta', '{italian}', '{comfort}', '{dairy}'),
    (2, 'Simmered Black Beans', '{mexican}', '{meal_prep,comfort}', '{}'),
    (2, 'Red Lentil Dal', '{indian}', '{meal_prep,comfort}', '{dairy}'),
    (2, 'Egg Drop Soup', '{chinese}', '{quick_weeknight}', '{egg,gluten,poultry}'),
    (2, 'Shakshuka', '{middle_eastern,mediterranean}', '{breakfast,date_night}', '{egg,spicy}'),
    (2, 'Miso Soup with Tofu', '{japanese}', '{quick_weeknight}', '{fish}'),
    (2, 'Stovetop Oatmeal with Cinnamon', '{american}', '{breakfast,quick_weeknight}', '{gluten,dairy}'),
    -- Slot 3: Boiling and timing
    (3, NULL, '{italian}', '{quick_weeknight,comfort}', '{gluten}'),
    (3, 'Pesto Pasta', '{italian}', '{quick_weeknight}', '{gluten,dairy,nuts}'),
    (3, 'Soy-Sesame Noodles', '{chinese}', '{quick_weeknight}', '{gluten}'),
    (3, 'Cold Soba Noodles', '{japanese}', '{quick_weeknight,meal_prep}', '{gluten,fish}'),
    (3, 'Mac and Cheese', '{american}', '{comfort}', '{gluten,dairy}'),
    (3, 'Chili-Lime Corn on the Cob', '{mexican}', '{quick_weeknight}', '{spicy,dairy}'),
    (3, 'Thai Peanut Rice Noodles', '{thai}', '{quick_weeknight,date_night}', '{nuts,spicy,gluten}'),
    (3, 'Lemon Herb Boiled Potatoes', '{mediterranean}', '{meal_prep,comfort}', '{}'),
    -- Slot 4: High-heat sauteing
    (4, NULL, '{chinese}', '{quick_weeknight}', '{gluten}'),
    (4, 'Pepper and Onion Fajitas on Corn Tortillas', '{mexican}', '{quick_weeknight}', '{}'),
    (4, 'Chicken and Broccoli Stir-Fry', '{chinese}', '{quick_weeknight}', '{poultry,gluten}'),
    (4, 'Garlic Shrimp', '{mediterranean}', '{quick_weeknight,date_night}', '{shellfish}'),
    (4, 'Korean-Style Beef and Pepper Stir-Fry', '{korean}', '{quick_weeknight}', '{beef,gluten}'),
    (4, 'Thai Basil Tofu Stir-Fry', '{thai}', '{quick_weeknight}', '{spicy,fish,gluten}'),
    (4, 'Aloo Gobi', '{indian}', '{comfort,meal_prep}', '{spicy}'),
    (4, 'Garlic Sauteed Spinach', '{italian}', '{quick_weeknight}', '{}'),
    -- Slot 5: Pan toasting
    (5, NULL, '{american}', '{quick_weeknight,comfort}', '{dairy,gluten}'),
    (5, 'Black Bean Tacos on Toasted Corn Tortillas', '{mexican}', '{quick_weeknight}', '{}'),
    (5, 'Tomato Bruschetta', '{italian}', '{quick_weeknight,date_night}', '{gluten}'),
    (5, 'Pan-Toasted Chapati', '{indian}', '{comfort}', '{gluten}'),
    (5, 'Toasted Pita with Hummus', '{mediterranean}', '{quick_weeknight}', '{gluten}'),
    (5, 'Ham and Cheese Melt', '{american}', '{quick_weeknight,comfort}', '{pork,dairy,gluten}'),
    (5, 'Pan-Toasted Spiced Chickpeas', '{middle_eastern}', '{meal_prep,quick_weeknight}', '{}'),
    (5, 'Yaki Onigiri', '{japanese}', '{quick_weeknight}', '{gluten}'),
    -- Slot 6: Rice cooking
    (6, NULL, '{american}', '{quick_weeknight,meal_prep}', '{}'),
    (6, 'Mexican Rice', '{mexican}', '{quick_weeknight,meal_prep}', '{poultry}'),
    (6, 'Egg Fried Rice', '{chinese}', '{quick_weeknight}', '{egg,gluten}'),
    (6, 'Veggie Bibimbap Bowl', '{korean}', '{date_night,comfort}', '{egg,spicy,gluten}'),
    (6, 'Jeera Rice', '{indian}', '{quick_weeknight,meal_prep}', '{dairy}'),
    (6, 'Thai Coconut Rice', '{thai}', '{comfort}', '{}'),
    (6, 'Chicken Teriyaki Rice Bowl', '{japanese}', '{quick_weeknight,meal_prep}', '{poultry,gluten}'),
    (6, 'Lemon Spinach Rice', '{mediterranean}', '{meal_prep}', '{}'),
    -- Slot 7: Roasting basics
    (7, NULL, '{american}', '{meal_prep,quick_weeknight}', '{}'),
    (7, 'Roasted Sweet Potatoes and Black Beans', '{mexican}', '{meal_prep}', '{}'),
    (7, 'Roasted Tomatoes and Zucchini with Parmesan', '{italian}', '{quick_weeknight}', '{dairy}'),
    (7, 'Roasted Spiced Cauliflower', '{indian}', '{meal_prep}', '{spicy}'),
    (7, 'Lemon Herb Chicken Thighs and Potatoes', '{mediterranean}', '{comfort,meal_prep}', '{poultry}'),
    (7, 'Roasted Eggplant with Tahini', '{middle_eastern}', '{date_night}', '{}'),
    (7, 'Sheet Pan Sausage and Peppers', '{italian}', '{quick_weeknight,comfort}', '{pork}'),
    (7, 'Honey-Soy Salmon and Broccoli', '{japanese}', '{quick_weeknight,date_night}', '{fish,gluten}'),
    -- Slot 8: Protein searing
    (8, NULL, '{american}', '{quick_weeknight,meal_prep}', '{poultry}'),
    (8, 'Pan-Seared Tofu with Lime and Chili Flakes', '{thai}', '{quick_weeknight}', '{spicy}'),
    (8, 'Seared Halloumi with Tomatoes', '{mediterranean}', '{quick_weeknight,date_night}', '{dairy}'),
    (8, 'Seared Portobello Steaks', '{italian}', '{date_night}', '{mushrooms}'),
    (8, 'Pan-Seared Pork Chops with Apples', '{american}', '{comfort,date_night}', '{pork}'),
    (8, 'Pan-Seared Steak with Garlic Butter', '{american}', '{date_night}', '{beef,dairy}'),
    (8, 'Teriyaki Salmon', '{japanese}', '{quick_weeknight}', '{fish,gluten}'),
    (8, 'Garlic Lemon Pan-Seared Tofu', '{mediterranean}', '{quick_weeknight,meal_prep}', '{}'),
    (8, 'Seared Paneer', '{indian}', '{quick_weeknight}', '{dairy,spicy}'),
    -- Slot 9: Building flavor
    (9, NULL, '{american}', '{comfort,meal_prep}', '{}'),
    (9, 'Black Bean Soup', '{mexican}', '{meal_prep,comfort}', '{}'),
    (9, 'Tuscan White Bean Soup', '{italian}', '{meal_prep,comfort}', '{dairy}'),
    (9, 'Beef Chili', '{american}', '{meal_prep,comfort}', '{beef,spicy}'),
    (9, 'Coconut Mushroom Soup', '{thai}', '{date_night}', '{mushrooms,fish,spicy}'),
    (9, 'Red Lentil Soup', '{middle_eastern}', '{meal_prep,comfort}', '{}'),
    (9, 'Chana Masala', '{indian}', '{meal_prep,comfort}', '{spicy}'),
    (9, 'Lemon Chicken and Rice Soup', '{mediterranean}', '{comfort}', '{poultry,egg}'),
    -- Slot 10: Complete meal execution (mastery)
    (10, NULL, '{american}', '{comfort,date_night}', '{poultry}'),
    (10, 'Whole Roasted Cauliflower with Tahini', '{middle_eastern}', '{date_night}', '{}'),
    (10, 'Wild Rice Stuffed Acorn Squash', '{american}', '{comfort,date_night}', '{dairy,nuts}'),
    (10, 'Roasted Lemon Salmon with Potatoes', '{mediterranean}', '{date_night}', '{fish}'),
    (10, 'Tandoori-Style Roast Chicken Thighs', '{indian}', '{comfort}', '{poultry,dairy,spicy}'),
    (10, 'Roasted Pork Loin with Rosemary Potatoes', '{italian}', '{comfort,date_night}', '{pork}'),
    (10, 'Stuffed Peppers with Rice and Beans', '{mexican}', '{comfort,meal_prep}', '{dairy}'),
    (10, 'Miso-Glazed Eggplant with Rice', '{japanese}', '{date_night}', '{gluten}')
) AS v(slot_order, dish_name, cuisines, meal_types, contains)
JOIN path_slots s ON s.slot_order = v.slot_order;

-- -----------------------------------------------------------------------------
-- 3. excluded_contains: the one place dietary needs map to `contains` tags
-- vegetarian = no pork/beef/lamb/poultry/fish/shellfish; vegan = vegetarian
-- + no dairy/egg. Unknown needs exclude nothing.
-- -----------------------------------------------------------------------------
CREATE FUNCTION excluded_contains(p_dietary_needs TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT COALESCE(array_agg(DISTINCT m.tag ORDER BY m.tag), '{}'::TEXT[])
    FROM (VALUES
        ('vegetarian', 'pork'), ('vegetarian', 'beef'), ('vegetarian', 'lamb'),
        ('vegetarian', 'poultry'), ('vegetarian', 'fish'), ('vegetarian', 'shellfish'),
        ('vegan', 'pork'), ('vegan', 'beef'), ('vegan', 'lamb'),
        ('vegan', 'poultry'), ('vegan', 'fish'), ('vegan', 'shellfish'),
        ('vegan', 'dairy'), ('vegan', 'egg'),
        ('no_pork', 'pork'),
        ('no_beef', 'beef'),
        ('no_poultry', 'poultry'),
        ('no_fish', 'fish'),
        ('no_shellfish', 'shellfish'),
        ('dairy_free', 'dairy'),
        ('gluten_free', 'gluten'),
        ('nut_free', 'nuts'),
        ('egg_free', 'egg'),
        ('no_mushrooms', 'mushrooms'),
        ('no_spicy', 'spicy')
    ) AS m(need, tag)
    WHERE m.need = ANY (COALESCE(p_dietary_needs, '{}'::TEXT[]));
$$;

REVOKE EXECUTE ON FUNCTION excluded_contains(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION excluded_contains(TEXT[]) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. user_path_dishes: the dish picked for a user + slot
-- Written only by personalize_my_path(). dish_name is a snapshot.
-- -----------------------------------------------------------------------------
CREATE TABLE user_path_dishes (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    catalog_dish_id BIGINT NOT NULL REFERENCES dish_catalog(id) ON DELETE CASCADE,
    dish_name TEXT NOT NULL,
    chosen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, slot_id)
);

ALTER TABLE user_path_dishes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own path dishes"
    ON user_path_dishes FOR SELECT
    USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE for clients: writes only via personalize_my_path().
REVOKE ALL ON user_path_dishes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON user_path_dishes TO authenticated;
GRANT SELECT ON user_path_dishes TO service_role;

-- -----------------------------------------------------------------------------
-- 4b. personalize_path_hits: per-user rate limit for personalize_my_path()
-- Changing a dish deletes the cached recipe (a new model generation), so
-- toggling preferences is capped at 10 calls per rolling hour. Dietary_needs
-- changes (profiles trigger) also record a hit, so they count toward the same
-- budget but are never blocked. A re-pick that fixes a diet conflict bypasses
-- the limit (see personalize_my_path). Server-only: RLS on, no client
-- policies or grants.
-- -----------------------------------------------------------------------------
CREATE TABLE personalize_path_hits (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX personalize_path_hits_user_occurred_idx
    ON personalize_path_hits (user_id, occurred_at);

ALTER TABLE personalize_path_hits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON personalize_path_hits FROM PUBLIC, anon, authenticated;
GRANT ALL ON personalize_path_hits TO service_role;

DO $$
DECLARE
    seq text;
BEGIN
    seq := pg_get_serial_sequence('public.personalize_path_hits', 'id');
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
END
$$;

-- -----------------------------------------------------------------------------
-- 4c. lock_unstarted_slot: the one safe way to clear a cached recipe
-- Internal helper (no grants to anon/authenticated). It locks the user's
-- user_recipes row for the slot (check-ins and mastery sessions take a KEY
-- SHARE lock on it when inserted), then re-checks "started" in a NEW statement
-- (fresh snapshot). Returns FALSE when the slot is started (nothing deleted).
-- Returns TRUE when it is not started; with p_delete it also deletes the
-- recipe, never one that has a check-in (check-ins cascade to XP).
-- -----------------------------------------------------------------------------
CREATE FUNCTION lock_unstarted_slot(p_user_id UUID, p_slot_id INTEGER, p_delete BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM 1 FROM public.user_recipes ur
    WHERE ur.user_id = p_user_id AND ur.slot_id = p_slot_id
    FOR UPDATE;

    IF EXISTS (SELECT 1 FROM public.check_ins c WHERE c.user_id = p_user_id AND c.slot_id = p_slot_id)
       OR EXISTS (SELECT 1 FROM public.user_slot_completions u WHERE u.user_id = p_user_id AND u.slot_id = p_slot_id)
       OR EXISTS (SELECT 1 FROM public.mastery_sessions m WHERE m.user_id = p_user_id AND m.slot_id = p_slot_id)
    THEN
        RETURN FALSE;
    END IF;

    IF p_delete THEN
        DELETE FROM public.user_recipes ur
        WHERE ur.user_id = p_user_id AND ur.slot_id = p_slot_id
          AND NOT EXISTS (SELECT 1 FROM public.check_ins c WHERE c.user_recipe_id = ur.id);
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION lock_unstarted_slot(UUID, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lock_unstarted_slot(UUID, INTEGER, BOOLEAN) TO service_role;

-- -----------------------------------------------------------------------------
-- 4d. Changing dietary_needs invalidates cached recipes of unstarted slots
-- Independent of personalize_my_path (which may keep the same dish, be rate
-- limited, or fail). Compared as sets, so reordering fires nothing. Removing a
-- restriction also invalidates (the cached recipe may be over-restricted).
-- Started slots keep their recipe and every check-in.
-- -----------------------------------------------------------------------------
CREATE FUNCTION profiles_dietary_needs_invalidate_recipes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_slot INTEGER;
BEGIN
    IF (SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::TEXT[]) FROM unnest(OLD.dietary_needs) AS x)
       IS NOT DISTINCT FROM
       (SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::TEXT[]) FROM unnest(NEW.dietary_needs) AS x)
    THEN
        RETURN NEW;
    END IF;

    -- Count this change toward the hourly personalize_my_path budget (never
    -- blocks: a user must always be able to save an allergy).
    INSERT INTO public.personalize_path_hits (user_id) VALUES (NEW.id);

    FOR v_slot IN SELECT s.id FROM public.path_slots s ORDER BY s.slot_order LOOP
        PERFORM public.lock_unstarted_slot(NEW.id, v_slot, TRUE);
    END LOOP;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION profiles_dietary_needs_invalidate_recipes() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profiles_dietary_needs_invalidate_recipes
    AFTER UPDATE OF dietary_needs ON profiles
    FOR EACH ROW
    WHEN (OLD.dietary_needs IS DISTINCT FROM NEW.dietary_needs)
    EXECUTE FUNCTION profiles_dietary_needs_invalidate_recipes();

-- -----------------------------------------------------------------------------
-- 5. personalize_my_path: choose the dish for every NOT STARTED slot
-- started = a check-in, a user_slot_completions row, or a mastery session for
-- that slot. Started slots are never touched.
-- candidates = catalog dishes for the slot whose `contains` does not overlap
--              excluded_contains(profile.dietary_needs)
-- score      = 2 * matching cuisines + matching meal types
-- order      = score desc, then the slot's canonical dish first (so no preferences
--              gives the classic path), then md5(user_id || dish id) (stable)
-- No candidate (impossible restriction combo): the user's pick for that slot is
-- removed and the canonical dish is used. The recipe generator still receives
-- the dietary needs, so it can adapt that canonical dish.
-- A changed dish deletes the user's cached user_recipes row for that slot
-- (it was generated for the old dish).
-- Returns all 10 slots with the dish now in effect.
-- Rate limit: at most 10 calls per user per rolling hour (diet changes count
-- toward it); over the limit it raises 'PERSONALIZE_RATE_LIMITED' (SQLSTATE
-- P0001) and changes nothing. EXCEPTION: if any unstarted slot's current pick
-- conflicts with the user's current dietary needs, the call is always allowed
-- (a safety re-pick), and still records a hit.
-- Concurrency: before touching a slot the function locks that slot's
-- user_recipes row (check-ins and mastery sessions take a KEY SHARE lock on it
-- when inserted) and then re-checks "started" in a new statement, so a
-- check-in that commits meanwhile is seen and the slot is skipped. The recipe
-- DELETE also never removes a recipe that has a check-in (those cascade to XP).
-- -----------------------------------------------------------------------------
CREATE FUNCTION personalize_my_path()
RETURNS TABLE (slot_id INTEGER, dish_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
    v_user UUID := auth.uid();
    v_cuisines TEXT[];
    v_meal_types TEXT[];
    v_excluded TEXT[];
    v_slot RECORD;
    v_prev TEXT;
    v_pick_id BIGINT;
    v_pick_name TEXT;
    v_hits INTEGER;
    v_conflict BOOLEAN;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Serialize this user's calls so the count below cannot be raced.
    PERFORM pg_advisory_xact_lock(hashtextextended('personalize_my_path:' || v_user::TEXT, 0));
    DELETE FROM public.personalize_path_hits h
    WHERE h.user_id = v_user AND h.occurred_at <= NOW() - INTERVAL '1 hour';
    SELECT COUNT(*)::INTEGER INTO v_hits
    FROM public.personalize_path_hits h
    WHERE h.user_id = v_user;
    SELECT EXISTS (
        SELECT 1
        FROM public.user_path_dishes upd
        JOIN public.dish_catalog d ON d.id = upd.catalog_dish_id
        JOIN public.profiles pr ON pr.id = upd.user_id
        WHERE upd.user_id = v_user
          AND d.contains && public.excluded_contains(pr.dietary_needs)
          AND NOT EXISTS (SELECT 1 FROM public.check_ins c WHERE c.user_id = v_user AND c.slot_id = upd.slot_id)
          AND NOT EXISTS (SELECT 1 FROM public.user_slot_completions u WHERE u.user_id = v_user AND u.slot_id = upd.slot_id)
          AND NOT EXISTS (SELECT 1 FROM public.mastery_sessions m WHERE m.user_id = v_user AND m.slot_id = upd.slot_id)
    ) INTO v_conflict;
    IF v_hits >= 10 AND NOT v_conflict THEN
        RAISE EXCEPTION 'PERSONALIZE_RATE_LIMITED'
            USING ERRCODE = 'P0001', HINT = 'At most 10 path updates per hour';
    END IF;
    INSERT INTO public.personalize_path_hits (user_id) VALUES (v_user);

    SELECT pr.cuisines, pr.meal_types, public.excluded_contains(pr.dietary_needs)
    INTO v_cuisines, v_meal_types, v_excluded
    FROM public.profiles pr
    WHERE pr.id = v_user;

    IF NOT FOUND THEN
        v_cuisines := '{}';
        v_meal_types := '{}';
        v_excluded := '{}';
    END IF;

    FOR v_slot IN
        SELECT s.id AS sid, s.dish_name AS canonical
        FROM public.path_slots s
        WHERE NOT EXISTS (SELECT 1 FROM public.check_ins c WHERE c.user_id = v_user AND c.slot_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM public.user_slot_completions u WHERE u.user_id = v_user AND u.slot_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM public.mastery_sessions m WHERE m.user_id = v_user AND m.slot_id = s.id)
        ORDER BY s.slot_order
    LOOP
        -- Lock the slot's recipe row, then re-check "started" in a NEW statement
        -- (fresh snapshot) so a concurrently committed check-in is seen.
        IF NOT public.lock_unstarted_slot(v_user, v_slot.sid, FALSE) THEN
            CONTINUE;
        END IF;

        SELECT upd.dish_name INTO v_prev
        FROM public.user_path_dishes upd
        WHERE upd.user_id = v_user AND upd.slot_id = v_slot.sid;
        v_prev := COALESCE(v_prev, v_slot.canonical);

        v_pick_id := NULL;
        v_pick_name := NULL;
        SELECT d.id, d.dish_name INTO v_pick_id, v_pick_name
        FROM public.dish_catalog d
        WHERE d.slot_id = v_slot.sid
          AND NOT (d.contains && v_excluded)
        ORDER BY
            (2 * COALESCE(cardinality(ARRAY(SELECT UNNEST(d.cuisines) INTERSECT SELECT UNNEST(v_cuisines))), 0)
             + COALESCE(cardinality(ARRAY(SELECT UNNEST(d.meal_types) INTERSECT SELECT UNNEST(v_meal_types))), 0)) DESC,
            (d.dish_name = v_slot.canonical) DESC,
            md5(v_user::TEXT || d.id::TEXT)
        LIMIT 1;

        IF v_pick_id IS NULL THEN
            DELETE FROM public.user_path_dishes upd
            WHERE upd.user_id = v_user AND upd.slot_id = v_slot.sid;
            v_pick_name := v_slot.canonical;
        ELSE
            INSERT INTO public.user_path_dishes (user_id, slot_id, catalog_dish_id, dish_name, chosen_at)
            VALUES (v_user, v_slot.sid, v_pick_id, v_pick_name, NOW())
            ON CONFLICT (user_id, slot_id) DO UPDATE
                SET catalog_dish_id = EXCLUDED.catalog_dish_id,
                    dish_name = EXCLUDED.dish_name,
                    chosen_at = EXCLUDED.chosen_at;
        END IF;

        IF v_pick_name IS DISTINCT FROM v_prev THEN
            PERFORM public.lock_unstarted_slot(v_user, v_slot.sid, TRUE);
        END IF;
    END LOOP;

    RETURN QUERY
    SELECT s.id, COALESCE(upd.dish_name, s.dish_name)
    FROM public.path_slots s
    LEFT JOIN public.user_path_dishes upd ON upd.user_id = v_user AND upd.slot_id = s.id
    ORDER BY s.slot_order;
END;
$$;

REVOKE EXECUTE ON FUNCTION personalize_my_path() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION personalize_my_path() TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Plan and recipe book return the personalized dish name.
-- Bodies are copied from the latest definitions (get_plan_for_user from
-- 20261115000000_plan_badges_recipe_book.sql, get_recipe_book_v2_for_user from
-- 20261118150000_recipe_book_cook_anything.sql). The only change is
-- COALESCE(upd.dish_name, s.dish_name) via LEFT JOIN user_path_dishes.
-- get_plan_summary_for_user returns no dish name, so it is not changed (its
-- suggested sessions still use the slot's canonical cook_minutes).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_plan_for_user(p_user_id UUID)
RETURNS TABLE (
    slot_id INTEGER,
    slot_order INTEGER,
    dish_name TEXT,
    technique_focus TEXT,
    xp_value INTEGER,
    is_final BOOLEAN,
    status TEXT,
    has_recipe BOOLEAN,
    times_completed INTEGER,
    first_completed_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH done AS (
        SELECT * FROM first_check_ins_for_user(p_user_id)
    ),
    current_slot AS (
        SELECT MIN(s.slot_order) AS slot_order
        FROM path_slots s
        WHERE NOT EXISTS (SELECT 1 FROM done d WHERE d.slot_id = s.id)
    )
    SELECT
        s.id,
        s.slot_order,
        COALESCE(upd.dish_name, s.dish_name),
        s.technique_focus,
        s.xp_value,
        COALESCE(s.is_final, FALSE),
        CASE
            WHEN d.slot_id IS NOT NULL THEN 'done'
            WHEN s.slot_order = (SELECT slot_order FROM current_slot) THEN 'current'
            ELSE 'locked'
        END,
        EXISTS (
            SELECT 1 FROM user_recipes ur
            WHERE ur.user_id = p_user_id AND ur.slot_id = s.id
        ),
        COALESCE(d.times_completed, 0),
        d.completed_at
    FROM path_slots s
    LEFT JOIN done d ON d.slot_id = s.id
    LEFT JOIN user_path_dishes upd ON upd.user_id = p_user_id AND upd.slot_id = s.id
    ORDER BY s.slot_order;
$$;

CREATE OR REPLACE FUNCTION get_recipe_book_v2_for_user(p_user_id UUID)
RETURNS TABLE (
    slot_id INTEGER,
    slot_order INTEGER,
    dish_name TEXT,
    user_recipe_id UUID,
    recipe_title TEXT,
    label TEXT,
    added_at TIMESTAMPTZ,
    times_cooked INTEGER,
    kind TEXT,
    generated_recipe_id UUID,
    last_cooked_at TIMESTAMPTZ,
    last_difficulty_rating TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH path_last AS (
        SELECT
            c.slot_id AS sid,
            MAX(c.created_at) AS last_at,
            (ARRAY_AGG(c.difficulty_rating ORDER BY c.created_at DESC, c.id DESC))[1] AS last_rating
        FROM check_ins c
        WHERE c.user_id = p_user_id
        GROUP BY c.slot_id
    ),
    cook_rows AS (
        SELECT
            r.id AS rid,
            r.dish_query AS dish_query,
            COALESCE(NULLIF(r.recipe_json->>'title', ''), r.dish_query) AS title,
            MIN(g.created_at) AS first_at,
            MAX(g.created_at) AS last_at,
            COUNT(*)::INTEGER AS n,
            (ARRAY_AGG(g.difficulty_rating ORDER BY g.created_at DESC, g.id DESC))[1] AS last_rating
        FROM user_generated_recipes r
        JOIN generated_recipe_check_ins g
          ON g.generated_recipe_id = r.id AND g.user_id = p_user_id
        WHERE r.user_id = p_user_id
        GROUP BY r.id, r.dish_query, r.recipe_json
    ),
    combined AS (
        SELECT
            s.id AS c_slot_id,
            s.slot_order AS c_slot_order,
            COALESCE(upd.dish_name, s.dish_name) AS c_dish_name,
            ur.id AS c_user_recipe_id,
            COALESCE(ur.recipe_json->>'title', upd.dish_name, s.dish_name) AS c_title,
            CASE WHEN s.is_final THEN 'mastered' ELSE 'completed' END AS c_label,
            d.completed_at AS c_added_at,
            d.times_completed AS c_times,
            'path'::TEXT AS c_kind,
            NULL::UUID AS c_generated_id,
            pl.last_at AS c_last_at,
            pl.last_rating AS c_last_rating
        FROM first_check_ins_for_user(p_user_id) d
        JOIN path_slots s ON s.id = d.slot_id
        LEFT JOIN user_recipes ur ON ur.user_id = p_user_id AND ur.slot_id = s.id
        LEFT JOIN user_path_dishes upd ON upd.user_id = p_user_id AND upd.slot_id = s.id
        LEFT JOIN path_last pl ON pl.sid = s.id
        UNION ALL
        SELECT
            NULL::INTEGER,
            NULL::INTEGER,
            k.dish_query,
            NULL::UUID,
            k.title,
            'completed',
            k.first_at,
            k.n,
            'cook_anything'::TEXT,
            k.rid,
            k.last_at,
            k.last_rating
        FROM cook_rows k
    )
    SELECT
        x.c_slot_id,
        x.c_slot_order,
        x.c_dish_name,
        x.c_user_recipe_id,
        x.c_title,
        x.c_label,
        x.c_added_at,
        x.c_times,
        x.c_kind,
        x.c_generated_id,
        x.c_last_at,
        x.c_last_rating
    FROM combined x
    -- Path entries first, in path order (as before); then Cook anything,
    -- oldest first. Clients re-sort for display.
    ORDER BY (x.c_kind = 'cook_anything'), x.c_slot_order, x.c_added_at, x.c_generated_id;
$$;
