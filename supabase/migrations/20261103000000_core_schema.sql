-- =============================================================================
-- Simmer MVP - Core Schema (DRAFT)
-- =============================================================================
-- This migration is a DRAFT for team review. Back-end ownership is TBD.
-- Tables: profiles, path_slots, user_recipes, check_ins, xp_events
-- Enables RLS so users can only read their own rows.
-- xp_events: clients CANNOT insert/update - only service role or SECURITY DEFINER functions.
-- user_recipes: clients CANNOT insert - only service role (recipe generator)
-- xp_config: clients can only SELECT - no INSERT/UPDATE/DELETE
-- 
-- SECURITY NOTES:
-- - award_slot_xp takes only check_in_id and derives user/slot from that row
-- - check_ins INSERT is validated against user_recipes ownership
-- - is_repeat is computed server-side, not client-supplied
-- - Weekly cap uses advisory lock for concurrency safety
-- 
-- LANE NOTE: XP values, repeat %, weekly cap, and dish list need Ian's sign-off
-- (gamification). Schema ownership needs Ezzeldin's sign-off (back end).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Configuration table for XP rules (easy to change without code deploys)
-- B4 FIX: RLS enabled, read-only for clients, no INSERT/UPDATE/DELETE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xp_config (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value >= 0),
    description TEXT,
    CONSTRAINT valid_repeat_percent CHECK (
        key != 'repeat_xp_percent' OR (value >= 0 AND value <= 100)
    )
);

-- B4 FIX: Enable RLS and restrict client access to read-only
ALTER TABLE xp_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view XP config" ON xp_config;
CREATE POLICY "Anyone can view XP config"
    ON xp_config FOR SELECT
    USING (TRUE);

-- Belt and braces: explicitly revoke write access from client roles
REVOKE INSERT, UPDATE, DELETE ON xp_config FROM anon, authenticated;

INSERT INTO xp_config (key, value, description) VALUES
    ('repeat_xp_percent', 50, 'Percentage of XP awarded for repeat completions (0-100)'),
    ('weekly_repeat_cap', 100, 'Maximum repeat XP a user can earn per week')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- profiles: stores onboarding answers
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    goals TEXT,
    experience_level TEXT CHECK (experience_level IN ('never_cooked', 'a_little', 'comfortable')),
    equipment TEXT[],
    budget TEXT CHECK (budget IN ('low', 'medium', 'high')),
    days_per_week INTEGER CHECK (days_per_week BETWEEN 1 AND 7),
    minutes_per_session INTEGER CHECK (minutes_per_session > 0),
    onboarding_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile"
    ON profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- -----------------------------------------------------------------------------
-- path_slots: 10 placeholder slots defining the learning path
-- These are static data, not user-specific
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS path_slots (
    id SERIAL PRIMARY KEY,
    slot_order INTEGER NOT NULL UNIQUE CHECK (slot_order BETWEEN 1 AND 10),
    dish_name TEXT NOT NULL,
    technique_focus TEXT NOT NULL,
    xp_value INTEGER NOT NULL CHECK (xp_value > 0),
    is_final BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE path_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view path slots" ON path_slots;
CREATE POLICY "Anyone can view path slots"
    ON path_slots FOR SELECT
    USING (TRUE);

-- Seed the 10 path slots with placeholder values
-- XP values increase along the path; slot 10 is the mastery challenge
-- NOTE: Dish names for slots 5-9 are placeholders; confirm with Ian (gamification owner)
INSERT INTO path_slots (slot_order, dish_name, technique_focus, xp_value, is_final) VALUES
    (1, 'Knife Basics Salad', 'Knife skills', 40, FALSE),
    (2, 'Scrambled Eggs', 'Heat control', 50, FALSE),
    (3, 'Pasta with Sauce', 'Boiling and timing', 60, FALSE),
    (4, 'Stir-Fry Vegetables', 'High-heat sautéing', 70, FALSE),
    (5, 'Grilled Cheese', 'Pan toasting', 80, FALSE),
    (6, 'Rice Bowl', 'Rice cooking', 90, FALSE),
    (7, 'Sheet Pan Vegetables', 'Roasting basics', 100, FALSE),
    (8, 'Seared Chicken Breast', 'Protein searing', 110, FALSE),
    (9, 'Simple Soup', 'Building flavor', 130, FALSE),
    (10, 'Roast Chicken', 'Complete meal execution', 150, TRUE)
ON CONFLICT (slot_order) DO NOTHING;

-- -----------------------------------------------------------------------------
-- user_recipes: generated recipe per user+slot (unique constraint)
-- S5 FIX: NO client INSERT - only service role (recipe generator) can write
-- This prevents clients from creating recipes for any slot to bypass path order
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    recipe_json JSONB NOT NULL,
    video_ids JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, slot_id)
);

ALTER TABLE user_recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own recipes" ON user_recipes;
CREATE POLICY "Users can view own recipes"
    ON user_recipes FOR SELECT
    USING (auth.uid() = user_id);

-- S5 FIX: No INSERT policy for clients - service role only
-- The recipe generator (ai-server) uses service_role key to insert recipes
-- This prevents clients from creating recipes to bypass path progression

-- -----------------------------------------------------------------------------
-- check_ins: feedback after completing a recipe
-- SECURITY: INSERT validates that user_recipe belongs to the caller and slot matches
-- is_repeat is computed server-side by award_slot_xp, not trusted from client
-- N6 FIX: Added length constraints on text fields to bound token cost/injection
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_ins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_recipe_id UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    difficulty_rating TEXT NOT NULL CHECK (difficulty_rating IN ('easy', 'ok', 'hard')),
    went_well TEXT CHECK (went_well IS NULL OR char_length(went_well) <= 500),
    was_hard TEXT CHECK (was_hard IS NULL OR char_length(was_hard) <= 500),
    is_repeat BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE check_ins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own check-ins" ON check_ins;
CREATE POLICY "Users can view own check-ins"
    ON check_ins FOR SELECT
    USING (auth.uid() = user_id);

-- B2 FIX: Validate that user_recipe belongs to caller AND slot_id matches the recipe's slot
-- This prevents clients from creating check-ins for arbitrary slots or other users' recipes
DROP POLICY IF EXISTS "Users can insert own check-ins with valid recipe" ON check_ins;
CREATE POLICY "Users can insert own check-ins with valid recipe"
    ON check_ins FOR INSERT
    WITH CHECK (
        auth.uid() = user_id
        AND EXISTS (
            SELECT 1 FROM user_recipes ur
            WHERE ur.id = user_recipe_id
              AND ur.user_id = auth.uid()
              AND ur.slot_id = check_ins.slot_id
        )
    );

-- -----------------------------------------------------------------------------
-- xp_events: immutable XP award log
-- CRITICAL: Clients CANNOT insert or update. Only service role or SECURITY DEFINER.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    check_in_id UUID NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    xp_awarded INTEGER NOT NULL CHECK (xp_awarded >= 0),
    is_first_completion BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (check_in_id)
);

ALTER TABLE xp_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own XP events" ON xp_events;
CREATE POLICY "Users can view own XP events"
    ON xp_events FOR SELECT
    USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for clients

DROP INDEX IF EXISTS idx_xp_events_user_created;
DROP INDEX IF EXISTS idx_xp_events_user_slot;
CREATE INDEX idx_xp_events_user_created ON xp_events (user_id, created_at);
CREATE INDEX idx_xp_events_user_slot ON xp_events (user_id, slot_id);

-- -----------------------------------------------------------------------------
-- user_slot_completions: tracks which slots a user has completed at least once
-- Used to determine first vs repeat completion (server-side only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_slot_completions (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    first_completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, slot_id)
);

ALTER TABLE user_slot_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own completions" ON user_slot_completions;
CREATE POLICY "Users can view own completions"
    ON user_slot_completions FOR SELECT
    USING (auth.uid() = user_id);

-- No INSERT/UPDATE from clients - managed exclusively by award_slot_xp

-- -----------------------------------------------------------------------------
-- award_slot_xp: SECURITY DEFINER function to award XP safely
-- 
-- B1 FIX: Takes ONLY p_check_in_id; derives user_id and slot_id from check_in row
-- Validates that check_in belongs to auth.uid() (or allows service_role bypass)
-- 
-- S1 FIX: Uses advisory lock for concurrency-safe weekly cap calculation
-- 
-- N8 FIX: Uses auth.role() for service-role detection (documented Supabase pattern)
-- 
-- Additional: is_repeat is computed from user_slot_completions, never from client
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS award_slot_xp(UUID, UUID, INTEGER);
DROP FUNCTION IF EXISTS award_slot_xp(UUID);

CREATE FUNCTION award_slot_xp(p_check_in_id UUID)
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
    -- N8 FIX: Use auth.role() for service-role detection (documented Supabase pattern)
    -- Service role bypasses ownership check for server-side calls
    v_is_service_role := COALESCE(auth.role(), '') = 'service_role';
    v_caller_uid := auth.uid();
    
    -- B1 FIX: Derive user_id and slot_id from the check_in row with FOR UPDATE lock
    SELECT c.user_id, c.slot_id
    INTO v_user_id, v_slot_id
    FROM check_ins c
    WHERE c.id = p_check_in_id
    FOR UPDATE;
    
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid or non-existent check_in_id: %', p_check_in_id;
    END IF;
    
    -- B1 FIX: Verify the check-in belongs to the caller (unless service_role)
    IF NOT v_is_service_role AND v_caller_uid IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'Access denied: check-in % does not belong to caller', p_check_in_id;
    END IF;
    
    -- S1 FIX: Acquire advisory lock per user for concurrency-safe weekly cap
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
    
    -- Get configurable values
    SELECT value INTO v_repeat_percent FROM xp_config WHERE key = 'repeat_xp_percent';
    SELECT value INTO v_weekly_cap FROM xp_config WHERE key = 'weekly_repeat_cap';
    
    v_repeat_percent := COALESCE(v_repeat_percent, 50);
    v_weekly_cap := COALESCE(v_weekly_cap, 100);
    
    -- Get slot's base XP value
    SELECT xp_value INTO v_slot_xp FROM path_slots WHERE id = v_slot_id;
    
    IF v_slot_xp IS NULL THEN
        RAISE EXCEPTION 'Invalid slot_id: %', v_slot_id;
    END IF;
    
    -- Determine first vs repeat from user_slot_completions (server-side only)
    -- Try to insert; if conflict, it's a repeat
    BEGIN
        INSERT INTO user_slot_completions (user_id, slot_id)
        VALUES (v_user_id, v_slot_id);
        v_is_first := TRUE;
    EXCEPTION WHEN unique_violation THEN
        v_is_first := FALSE;
    END;
    
    -- N3 FIX: Use explicit UTC for week calculation
    v_week_start := date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    
    -- Always compute weekly repeat used (N4 fix: compute for both paths)
    SELECT COALESCE(SUM(e.xp_awarded), 0)
    INTO v_weekly_repeat_used
    FROM xp_events e
    WHERE e.user_id = v_user_id
      AND e.created_at >= v_week_start
      AND e.is_first_completion = FALSE;
    
    -- Calculate XP to award
    IF v_is_first THEN
        v_xp_to_award := v_slot_xp;
    ELSE
        v_xp_to_award := (v_slot_xp * v_repeat_percent) / 100;
        
        -- Apply weekly cap
        IF v_weekly_repeat_used >= v_weekly_cap THEN
            v_xp_to_award := 0;
            v_capped := TRUE;
        ELSIF v_weekly_repeat_used + v_xp_to_award > v_weekly_cap THEN
            v_xp_to_award := v_weekly_cap - v_weekly_repeat_used;
            v_capped := TRUE;
        END IF;
    END IF;
    
    -- Insert XP event
    INSERT INTO xp_events (user_id, check_in_id, slot_id, xp_awarded, is_first_completion)
    VALUES (v_user_id, p_check_in_id, v_slot_id, v_xp_to_award, v_is_first);
    
    -- Update check_in's is_repeat field (server authoritative)
    UPDATE check_ins SET is_repeat = NOT v_is_first WHERE id = p_check_in_id;
    
    RETURN QUERY SELECT 
        v_xp_to_award,
        v_is_first,
        GREATEST(0, v_weekly_cap - v_weekly_repeat_used - 
            CASE WHEN v_is_first THEN 0 ELSE v_xp_to_award END)::INTEGER,
        v_capped;
END;
$$;

-- N7 FIX: Revoke from both PUBLIC and anon explicitly
REVOKE EXECUTE ON FUNCTION award_slot_xp(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION award_slot_xp(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION award_slot_xp(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- get_user_total_xp: helper to fetch the CALLER's total XP
-- S3 FIX: No parameter; uses auth.uid() directly to prevent leaking other users' XP
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_user_total_xp(UUID);
DROP FUNCTION IF EXISTS get_user_total_xp();

CREATE FUNCTION get_user_total_xp()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
BEGIN
    SELECT COALESCE(SUM(xp_awarded), 0)
    INTO v_total
    FROM xp_events
    WHERE user_id = auth.uid();
    
    RETURN v_total;
END;
$$;

-- N7 FIX: Revoke from both PUBLIC and anon explicitly
REVOKE EXECUTE ON FUNCTION get_user_total_xp() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_total_xp() FROM anon;
GRANT EXECUTE ON FUNCTION get_user_total_xp() TO authenticated;

-- -----------------------------------------------------------------------------
-- Trigger to update profiles.updated_at on changes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- FINAL SECURITY LOCKDOWN
-- These REVOKEs ensure clients cannot bypass RLS via table permissions.
-- They are placed at the end so they apply regardless of when roles are created.
-- In Supabase, the PostgREST layer grants broad access to authenticated/anon,
-- so we must explicitly revoke write access on sensitive tables.
-- -----------------------------------------------------------------------------

-- S5 FIX: user_recipes - no client INSERT (service-role only)
REVOKE INSERT ON user_recipes FROM anon, authenticated;

-- xp_events - no client INSERT/UPDATE/DELETE (SECURITY DEFINER function only)
REVOKE INSERT, UPDATE, DELETE ON xp_events FROM anon, authenticated;

-- user_slot_completions - no client INSERT/UPDATE/DELETE (SECURITY DEFINER function only)
REVOKE INSERT, UPDATE, DELETE ON user_slot_completions FROM anon, authenticated;
