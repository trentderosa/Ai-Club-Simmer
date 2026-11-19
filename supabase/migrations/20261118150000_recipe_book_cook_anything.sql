-- =============================================================================
-- Simmer - Recipe book includes "Cook anything" recipes (F10)
-- =============================================================================
-- Before: get_recipe_book_for_user / get_my_recipe_book only read path
-- check-ins (check_ins via first_check_ins_for_user), so a finished Cook
-- anything dish never reached the book.
-- After: path entries are unchanged, plus one entry per Cook anything recipe
-- that has at least one check-in (generated_recipe_check_ins).
--
-- New columns (appended, existing ones keep their order and meaning):
--   kind                   'path' | 'cook_anything'
--   generated_recipe_id    user_generated_recipes.id (null for path)
--   last_cooked_at         newest check-in time
--   last_difficulty_rating rating on the newest check-in
-- For cook_anything rows slot_id and slot_order are NULL, label is
-- 'completed', added_at is the first check-in time and times_cooked is the
-- number of check-ins. dish_name is the dish the user typed.
--
-- The return type changes, so both functions are dropped and recreated.
-- Grants are re-applied exactly as in 20261115000000 (service-role helper,
-- authenticated-only client RPC). No tables change; the check-in tables
-- already have owner-only SELECT policies, so the app can read its own
-- check-in history directly.
--
-- This is a NEW migration. Kai applies it to prod only after the PR is merged.
-- =============================================================================

DROP FUNCTION IF EXISTS get_my_recipe_book();
DROP FUNCTION IF EXISTS get_recipe_book_for_user(UUID);

CREATE FUNCTION get_recipe_book_for_user(p_user_id UUID)
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
            s.dish_name AS c_dish_name,
            ur.id AS c_user_recipe_id,
            COALESCE(ur.recipe_json->>'title', s.dish_name) AS c_title,
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

CREATE FUNCTION get_my_recipe_book()
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    RETURN QUERY SELECT * FROM get_recipe_book_for_user(auth.uid());
END;
$$;

REVOKE EXECUTE ON FUNCTION get_recipe_book_for_user(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_recipe_book_for_user(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION get_my_recipe_book() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_recipe_book() TO authenticated;
