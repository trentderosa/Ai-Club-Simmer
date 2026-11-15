-- =============================================================================
-- Simmer - Cook anything (free-form dishes)
-- =============================================================================
-- New feature: a user can type a dish name and get a generated recipe, then
-- cook and check in on it. The 10-slot path is unchanged.
--
-- This is a NEW migration. It does not edit merged migrations or core_schema.
-- Kai applies this to prod only after this PR is merged.
--
-- XP (pending Ian's OK on the clamp bounds and the daily cap):
--   Same formula as path slots, reading weights/scale from xp_config:
--     XP = max(1, round((steps*steps_weight + ingredients*ingredients_weight
--                        + minutes*cook_minutes_weight) * xp_multiplier))
--   Counts are taken from the validated recipe arrays, then clamped to
--   bounds in xp_config (defaults: steps 1-15, ingredients 1-20, minutes 1-120)
--   and stored on user_generated_recipes. Those stored counts and xp_value
--   are frozen at first insert for that (user, normalized dish name): a later
--   update or regeneration cannot raise them.
--   Repeat = 50% (repeat_xp_percent), keyed on normalized_dish_name.
--   Weekly repeat cap (weekly_repeat_cap, 100) is SHARED with slot repeats.
--   Daily cap (freeform_daily_cap) is applied to free-form awards and counts
--   today's slot XP and free-form XP together.
--   Award is server-side only (award_generated_recipe_xp, service_role).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Config: clamp bounds and the daily cap. Weights / repeat % / weekly cap
-- already live in xp_config. Defaults flagged in the PR for Ian/Trent.
-- -----------------------------------------------------------------------------
INSERT INTO xp_config (key, value, description) VALUES
    ('freeform_max_steps', 15, 'Cook-anything clamp: max steps counted for XP (needs Ian/Trent OK)'),
    ('freeform_max_ingredients', 20, 'Cook-anything clamp: max ingredients counted for XP (needs Ian/Trent OK)'),
    ('freeform_max_minutes', 120, 'Cook-anything clamp: max cook minutes counted for XP (needs Ian/Trent OK)'),
    ('freeform_min_steps', 1, 'Cook-anything clamp: min steps counted for XP'),
    ('freeform_min_ingredients', 1, 'Cook-anything clamp: min ingredients counted for XP'),
    ('freeform_min_minutes', 1, 'Cook-anything clamp: min cook minutes counted for XP'),
    ('freeform_daily_cap', 200, 'Max XP a user can earn per UTC day from free-form awards; the used total includes slot XP earned the same day (needs Ian/Trent OK)')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- user_generated_recipes: one saved recipe per user + normalized dish name.
-- Clients can SELECT their own rows only. Writes are service-role only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_generated_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    dish_query TEXT NOT NULL,
    normalized_dish_name TEXT NOT NULL,
    recipe_json JSONB NOT NULL,
    video_ids JSONB,
    step_count INTEGER NOT NULL,
    ingredient_count INTEGER NOT NULL,
    time_estimate_minutes INTEGER NOT NULL,
    xp_value INTEGER NOT NULL CHECK (xp_value >= 1),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, normalized_dish_name)
);

CREATE INDEX IF NOT EXISTS idx_user_generated_recipes_user
    ON user_generated_recipes (user_id);

ALTER TABLE user_generated_recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generated recipes" ON user_generated_recipes;
CREATE POLICY "Users can view own generated recipes"
    ON user_generated_recipes FOR SELECT
    USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON user_generated_recipes FROM anon, authenticated;
GRANT SELECT ON user_generated_recipes TO authenticated;

-- Clamp counts and stamp xp_value from xp_config on first insert only.
CREATE OR REPLACE FUNCTION set_generated_recipe_xp_inputs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_steps_weight NUMERIC;
    v_ingredients_weight NUMERIC;
    v_cook_minutes_weight NUMERIC;
    v_multiplier NUMERIC;
    v_min_steps INTEGER;
    v_max_steps INTEGER;
    v_min_ingredients INTEGER;
    v_max_ingredients INTEGER;
    v_min_minutes INTEGER;
    v_max_minutes INTEGER;
BEGIN
    SELECT value INTO v_steps_weight FROM xp_config WHERE key = 'steps_weight';
    SELECT value INTO v_ingredients_weight FROM xp_config WHERE key = 'ingredients_weight';
    SELECT value INTO v_cook_minutes_weight FROM xp_config WHERE key = 'cook_minutes_weight';
    SELECT value INTO v_multiplier FROM xp_config WHERE key = 'xp_multiplier';
    SELECT value::INTEGER INTO v_min_steps FROM xp_config WHERE key = 'freeform_min_steps';
    SELECT value::INTEGER INTO v_max_steps FROM xp_config WHERE key = 'freeform_max_steps';
    SELECT value::INTEGER INTO v_min_ingredients FROM xp_config WHERE key = 'freeform_min_ingredients';
    SELECT value::INTEGER INTO v_max_ingredients FROM xp_config WHERE key = 'freeform_max_ingredients';
    SELECT value::INTEGER INTO v_min_minutes FROM xp_config WHERE key = 'freeform_min_minutes';
    SELECT value::INTEGER INTO v_max_minutes FROM xp_config WHERE key = 'freeform_max_minutes';

    v_steps_weight := COALESCE(v_steps_weight, 0.45);
    v_ingredients_weight := COALESCE(v_ingredients_weight, 0.35);
    v_cook_minutes_weight := COALESCE(v_cook_minutes_weight, 0.2);
    v_multiplier := COALESCE(v_multiplier, 10);
    v_min_steps := COALESCE(v_min_steps, 1);
    v_max_steps := COALESCE(v_max_steps, 15);
    v_min_ingredients := COALESCE(v_min_ingredients, 1);
    v_max_ingredients := COALESCE(v_max_ingredients, 20);
    v_min_minutes := COALESCE(v_min_minutes, 1);
    v_max_minutes := COALESCE(v_max_minutes, 120);

    NEW.step_count := LEAST(GREATEST(NEW.step_count, v_min_steps), v_max_steps);
    NEW.ingredient_count := LEAST(GREATEST(NEW.ingredient_count, v_min_ingredients), v_max_ingredients);
    NEW.time_estimate_minutes := LEAST(GREATEST(NEW.time_estimate_minutes, v_min_minutes), v_max_minutes);

    NEW.xp_value := GREATEST(1, ROUND(
        (NEW.step_count * v_steps_weight +
         NEW.ingredient_count * v_ingredients_weight +
         NEW.time_estimate_minutes * v_cook_minutes_weight) * v_multiplier
    ))::INTEGER;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_generated_recipes_set_xp ON user_generated_recipes;
CREATE TRIGGER user_generated_recipes_set_xp
    BEFORE INSERT ON user_generated_recipes
    FOR EACH ROW
    EXECUTE FUNCTION set_generated_recipe_xp_inputs();

-- A reroll / regeneration / recipe_json update cannot raise the frozen XP inputs.
CREATE OR REPLACE FUNCTION freeze_generated_recipe_xp_inputs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    NEW.step_count := OLD.step_count;
    NEW.ingredient_count := OLD.ingredient_count;
    NEW.time_estimate_minutes := OLD.time_estimate_minutes;
    NEW.xp_value := OLD.xp_value;
    NEW.normalized_dish_name := OLD.normalized_dish_name;
    NEW.user_id := OLD.user_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_generated_recipes_freeze_xp ON user_generated_recipes;
CREATE TRIGGER user_generated_recipes_freeze_xp
    BEFORE UPDATE ON user_generated_recipes
    FOR EACH ROW
    EXECUTE FUNCTION freeze_generated_recipe_xp_inputs();

REVOKE EXECUTE ON FUNCTION set_generated_recipe_xp_inputs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION freeze_generated_recipe_xp_inputs() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- user_generated_dish_completions: first completion of a normalized dish
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_generated_dish_completions (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    normalized_dish_name TEXT NOT NULL,
    first_completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, normalized_dish_name)
);

ALTER TABLE user_generated_dish_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generated dish completions" ON user_generated_dish_completions;
CREATE POLICY "Users can view own generated dish completions"
    ON user_generated_dish_completions FOR SELECT
    USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON user_generated_dish_completions FROM anon, authenticated;
GRANT SELECT ON user_generated_dish_completions TO authenticated;

-- -----------------------------------------------------------------------------
-- generated_recipe_check_ins: check-ins on free-form dishes
-- id is the client idempotency key when provided (same pattern as check_ins).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_recipe_check_ins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    generated_recipe_id UUID NOT NULL REFERENCES user_generated_recipes(id) ON DELETE CASCADE,
    difficulty_rating TEXT NOT NULL CHECK (difficulty_rating IN ('easy', 'ok', 'hard')),
    went_well TEXT CHECK (went_well IS NULL OR char_length(went_well) <= 500),
    was_hard TEXT CHECK (was_hard IS NULL OR char_length(was_hard) <= 500),
    is_repeat BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_recipe_check_ins_user
    ON generated_recipe_check_ins (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generated_recipe_check_ins_recipe
    ON generated_recipe_check_ins (generated_recipe_id);

ALTER TABLE generated_recipe_check_ins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generated check-ins" ON generated_recipe_check_ins;
CREATE POLICY "Users can view own generated check-ins"
    ON generated_recipe_check_ins FOR SELECT
    USING (auth.uid() = user_id);

-- Service role (ai-server) is the only writer; awards are service_role only.
DROP POLICY IF EXISTS "Users can insert own generated check-ins" ON generated_recipe_check_ins;
REVOKE INSERT, UPDATE, DELETE ON generated_recipe_check_ins FROM anon, authenticated;
GRANT SELECT ON generated_recipe_check_ins TO authenticated;

-- -----------------------------------------------------------------------------
-- generated_recipe_xp_events: immutable free-form XP log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_recipe_xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    check_in_id UUID NOT NULL REFERENCES generated_recipe_check_ins(id) ON DELETE CASCADE,
    generated_recipe_id UUID NOT NULL REFERENCES user_generated_recipes(id) ON DELETE CASCADE,
    normalized_dish_name TEXT NOT NULL,
    xp_awarded INTEGER NOT NULL CHECK (xp_awarded >= 0),
    is_first_completion BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (check_in_id)
);

CREATE INDEX IF NOT EXISTS idx_generated_recipe_xp_events_user_created
    ON generated_recipe_xp_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generated_recipe_xp_events_user_dish
    ON generated_recipe_xp_events (user_id, normalized_dish_name);

ALTER TABLE generated_recipe_xp_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generated XP events" ON generated_recipe_xp_events;
CREATE POLICY "Users can view own generated XP events"
    ON generated_recipe_xp_events FOR SELECT
    USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON generated_recipe_xp_events FROM anon, authenticated;
GRANT SELECT ON generated_recipe_xp_events TO authenticated;

-- -----------------------------------------------------------------------------
-- award_generated_recipe_xp: service_role only, same shape as award_slot_xp.
-- Uses the frozen xp_value on the saved recipe (not a live recount of JSON).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION award_generated_recipe_xp(p_check_in_id UUID)
RETURNS TABLE (
    out_xp_awarded INTEGER,
    out_is_first_completion BOOLEAN,
    out_weekly_repeat_remaining INTEGER,
    out_capped BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_recipe_id UUID;
    v_dish TEXT;
    v_base_xp INTEGER;
    v_is_first BOOLEAN;
    v_repeat_percent INTEGER;
    v_weekly_cap INTEGER;
    v_daily_cap INTEGER;
    v_weekly_repeat_used INTEGER := 0;
    v_daily_used INTEGER := 0;
    v_xp_to_award INTEGER;
    v_capped BOOLEAN := FALSE;
    v_week_start TIMESTAMPTZ;
    v_day_start TIMESTAMPTZ;
    v_caller_uid UUID;
    v_is_service_role BOOLEAN;
BEGIN
    v_is_service_role := COALESCE(auth.role(), '') = 'service_role';
    v_caller_uid := auth.uid();

    SELECT c.user_id, c.generated_recipe_id
    INTO v_user_id, v_recipe_id
    FROM generated_recipe_check_ins c
    WHERE c.id = p_check_in_id
    FOR UPDATE;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid or non-existent check_in_id: %', p_check_in_id;
    END IF;

    IF NOT v_is_service_role AND v_caller_uid IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'Access denied: check-in % does not belong to caller', p_check_in_id;
    END IF;

    -- Distinct lock namespace from award_slot_xp, then both functions also
    -- see each other's awards when computing shared caps.
    PERFORM pg_advisory_xact_lock(hashtextextended('generated:' || v_user_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

    SELECT r.xp_value, r.normalized_dish_name
    INTO v_base_xp, v_dish
    FROM user_generated_recipes r
    WHERE r.id = v_recipe_id;

    IF v_base_xp IS NULL THEN
        RAISE EXCEPTION 'Invalid generated_recipe_id: %', v_recipe_id;
    END IF;

    SELECT value::INTEGER INTO v_repeat_percent FROM xp_config WHERE key = 'repeat_xp_percent';
    SELECT value::INTEGER INTO v_weekly_cap FROM xp_config WHERE key = 'weekly_repeat_cap';
    SELECT value::INTEGER INTO v_daily_cap FROM xp_config WHERE key = 'freeform_daily_cap';
    v_repeat_percent := COALESCE(v_repeat_percent, 50);
    v_weekly_cap := COALESCE(v_weekly_cap, 100);
    v_daily_cap := COALESCE(v_daily_cap, 200);

    BEGIN
        INSERT INTO user_generated_dish_completions (user_id, normalized_dish_name)
        VALUES (v_user_id, v_dish);
        v_is_first := TRUE;
    EXCEPTION WHEN unique_violation THEN
        v_is_first := FALSE;
    END;

    v_week_start := date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_day_start := date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

    -- Shared weekly repeat cap: slot repeats + free-form repeats.
    SELECT COALESCE(SUM(xp_awarded), 0) INTO v_weekly_repeat_used
    FROM (
        SELECT e.xp_awarded
        FROM xp_events e
        WHERE e.user_id = v_user_id
          AND e.created_at >= v_week_start
          AND e.is_first_completion = FALSE
        UNION ALL
        SELECT g.xp_awarded
        FROM generated_recipe_xp_events g
        WHERE g.user_id = v_user_id
          AND g.created_at >= v_week_start
          AND g.is_first_completion = FALSE
    ) weekly_repeats;

    -- Daily cap used total includes slot XP and free-form XP awarded today.
    SELECT COALESCE(SUM(xp_awarded), 0) INTO v_daily_used
    FROM (
        SELECT e.xp_awarded
        FROM xp_events e
        WHERE e.user_id = v_user_id
          AND e.created_at >= v_day_start
        UNION ALL
        SELECT g.xp_awarded
        FROM generated_recipe_xp_events g
        WHERE g.user_id = v_user_id
          AND g.created_at >= v_day_start
    ) daily_xp;

    IF v_is_first THEN
        v_xp_to_award := v_base_xp;
    ELSE
        v_xp_to_award := (v_base_xp * v_repeat_percent) / 100;
        IF v_weekly_repeat_used >= v_weekly_cap THEN
            v_xp_to_award := 0;
            v_capped := TRUE;
        ELSIF v_weekly_repeat_used + v_xp_to_award > v_weekly_cap THEN
            v_xp_to_award := v_weekly_cap - v_weekly_repeat_used;
            v_capped := TRUE;
        END IF;
    END IF;

    IF v_daily_used >= v_daily_cap THEN
        v_xp_to_award := 0;
        v_capped := TRUE;
    ELSIF v_daily_used + v_xp_to_award > v_daily_cap THEN
        v_xp_to_award := v_daily_cap - v_daily_used;
        v_capped := TRUE;
    END IF;

    INSERT INTO generated_recipe_xp_events (
        user_id, check_in_id, generated_recipe_id, normalized_dish_name, xp_awarded, is_first_completion
    ) VALUES (
        v_user_id, p_check_in_id, v_recipe_id, v_dish, v_xp_to_award, v_is_first
    );

    UPDATE generated_recipe_check_ins
    SET is_repeat = NOT v_is_first
    WHERE id = p_check_in_id;

    RETURN QUERY SELECT
        v_xp_to_award,
        v_is_first,
        GREATEST(0, v_weekly_cap - v_weekly_repeat_used -
            CASE WHEN v_is_first THEN 0 ELSE v_xp_to_award END)::INTEGER,
        v_capped;
END;
$$;

REVOKE EXECUTE ON FUNCTION award_generated_recipe_xp(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION award_generated_recipe_xp(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION award_generated_recipe_xp(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION award_generated_recipe_xp(UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- award_slot_xp: weekly repeat cap now also counts free-form repeat XP, so
-- the 100/week cap is shared. Signature and path first-completion rules are
-- unchanged. CREATE OR REPLACE keeps existing EXECUTE grants (service_role).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION award_slot_xp(p_check_in_id UUID)
RETURNS TABLE (
    out_xp_awarded INTEGER,
    out_is_first_completion BOOLEAN,
    out_weekly_repeat_remaining INTEGER,
    out_capped BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_slot_id INTEGER;
    v_slot_xp INTEGER;
    v_is_first BOOLEAN;
    v_repeat_percent INTEGER;
    v_weekly_cap INTEGER;
    v_weekly_repeat_used INTEGER := 0;
    v_xp_to_award INTEGER;
    v_capped BOOLEAN := FALSE;
    v_week_start TIMESTAMPTZ;
    v_caller_uid UUID;
    v_is_service_role BOOLEAN;
BEGIN
    v_is_service_role := COALESCE(auth.role(), '') = 'service_role';
    v_caller_uid := auth.uid();

    SELECT c.user_id, c.slot_id
    INTO v_user_id, v_slot_id
    FROM check_ins c
    WHERE c.id = p_check_in_id
    FOR UPDATE;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid or non-existent check_in_id: %', p_check_in_id;
    END IF;

    IF NOT v_is_service_role AND v_caller_uid IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'Access denied: check-in % does not belong to caller', p_check_in_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

    SELECT value INTO v_repeat_percent FROM xp_config WHERE key = 'repeat_xp_percent';
    SELECT value INTO v_weekly_cap FROM xp_config WHERE key = 'weekly_repeat_cap';
    v_repeat_percent := COALESCE(v_repeat_percent, 50);
    v_weekly_cap := COALESCE(v_weekly_cap, 100);

    SELECT xp_value INTO v_slot_xp FROM path_slots WHERE id = v_slot_id;
    IF v_slot_xp IS NULL THEN
        RAISE EXCEPTION 'Invalid slot_id: %', v_slot_id;
    END IF;

    BEGIN
        INSERT INTO user_slot_completions (user_id, slot_id)
        VALUES (v_user_id, v_slot_id);
        v_is_first := TRUE;
    EXCEPTION WHEN unique_violation THEN
        v_is_first := FALSE;
    END;

    v_week_start := date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

    SELECT COALESCE(SUM(xp_awarded), 0) INTO v_weekly_repeat_used
    FROM (
        SELECT e.xp_awarded
        FROM xp_events e
        WHERE e.user_id = v_user_id
          AND e.created_at >= v_week_start
          AND e.is_first_completion = FALSE
        UNION ALL
        SELECT g.xp_awarded
        FROM generated_recipe_xp_events g
        WHERE g.user_id = v_user_id
          AND g.created_at >= v_week_start
          AND g.is_first_completion = FALSE
    ) weekly_repeats;

    IF v_is_first THEN
        v_xp_to_award := v_slot_xp;
    ELSE
        v_xp_to_award := (v_slot_xp * v_repeat_percent) / 100;
        IF v_weekly_repeat_used >= v_weekly_cap THEN
            v_xp_to_award := 0;
            v_capped := TRUE;
        ELSIF v_weekly_repeat_used + v_xp_to_award > v_weekly_cap THEN
            v_xp_to_award := v_weekly_cap - v_weekly_repeat_used;
            v_capped := TRUE;
        END IF;
    END IF;

    INSERT INTO xp_events (user_id, check_in_id, slot_id, xp_awarded, is_first_completion)
    VALUES (v_user_id, p_check_in_id, v_slot_id, v_xp_to_award, v_is_first);

    UPDATE check_ins SET is_repeat = NOT v_is_first WHERE id = p_check_in_id;

    RETURN QUERY SELECT
        v_xp_to_award,
        v_is_first,
        GREATEST(0, v_weekly_cap - v_weekly_repeat_used -
            CASE WHEN v_is_first THEN 0 ELSE v_xp_to_award END)::INTEGER,
        v_capped;
END;
$$;

-- -----------------------------------------------------------------------------
-- Totals: path summary and get_user_total_xp include free-form awards.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_total_xp()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
BEGIN
    SELECT
        COALESCE((SELECT SUM(xp_awarded) FROM xp_events WHERE user_id = auth.uid()), 0)
        + COALESCE((SELECT SUM(xp_awarded) FROM generated_recipe_xp_events WHERE user_id = auth.uid()), 0)
    INTO v_total;
    RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION get_plan_summary_for_user(p_user_id UUID)
RETURNS TABLE (
    total_xp INTEGER,
    completed_slots INTEGER,
    total_slots INTEGER,
    current_slot_order INTEGER,
    path_complete BOOLEAN,
    days_per_week INTEGER,
    minutes_per_session INTEGER,
    suggested_sessions_per_week INTEGER,
    estimated_weeks_remaining INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_total_xp INTEGER;
    v_completed INTEGER;
    v_total INTEGER;
    v_current INTEGER;
    v_days INTEGER;
    v_minutes INTEGER;
    v_avg_minutes NUMERIC;
    v_suggested INTEGER;
    v_weeks INTEGER;
BEGIN
    SELECT
        COALESCE((SELECT SUM(e.xp_awarded) FROM xp_events e WHERE e.user_id = p_user_id), 0)
        + COALESCE((SELECT SUM(g.xp_awarded) FROM generated_recipe_xp_events g WHERE g.user_id = p_user_id), 0)
    INTO v_total_xp;

    SELECT
        COUNT(*) FILTER (WHERE p.status = 'done')::INTEGER,
        COUNT(*)::INTEGER,
        MIN(p.slot_order) FILTER (WHERE p.status = 'current')
    INTO v_completed, v_total, v_current
    FROM get_plan_for_user(p_user_id) p;

    SELECT pr.days_per_week, pr.minutes_per_session INTO v_days, v_minutes
    FROM profiles pr WHERE pr.id = p_user_id;

    IF v_days IS NOT NULL AND v_minutes IS NOT NULL THEN
        SELECT AVG(s.cook_minutes) INTO v_avg_minutes
        FROM get_plan_for_user(p_user_id) p
        JOIN path_slots s ON s.id = p.slot_id
        WHERE p.status <> 'done' AND s.cook_minutes IS NOT NULL;

        IF v_avg_minutes IS NULL THEN
            SELECT AVG(s.cook_minutes) INTO v_avg_minutes
            FROM path_slots s WHERE s.cook_minutes IS NOT NULL;
        END IF;

        IF v_avg_minutes IS NULL OR v_avg_minutes <= 0 THEN
            v_suggested := v_days;
        ELSE
            v_suggested := LEAST(v_days, GREATEST(1, FLOOR((v_days * v_minutes) / v_avg_minutes)::INTEGER));
        END IF;

        v_weeks := CEIL((v_total - v_completed)::NUMERIC / v_suggested)::INTEGER;
    END IF;

    RETURN QUERY SELECT
        v_total_xp,
        v_completed,
        v_total,
        v_current,
        v_completed = v_total,
        v_days,
        v_minutes,
        v_suggested,
        v_weeks;
END;
$$;
