-- =============================================================================
-- Simmer MVP - Core Schema (DRAFT)
-- =============================================================================
-- This migration is a DRAFT for team review. Back-end ownership is TBD.
-- Tables: profiles, path_slots, user_recipes, check_ins, xp_events
-- Enables RLS so users can only read their own rows.
-- xp_events: clients CANNOT insert/update - only service role or SECURITY DEFINER functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Configuration table for XP rules (easy to change without code deploys)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xp_config (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL,
    description TEXT
);

INSERT INTO xp_config (key, value, description) VALUES
    ('repeat_xp_percent', 50, 'Percentage of XP awarded for repeat completions'),
    ('weekly_repeat_cap', 100, 'Maximum repeat XP a user can earn per week')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- profiles: stores onboarding answers
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    goals TEXT,
    experience_level TEXT CHECK (experience_level IN ('never_cooked', 'a_little', 'comfortable')),
    equipment TEXT[], -- multi-select checklist
    budget TEXT CHECK (budget IN ('low', 'medium', 'high')),
    days_per_week INTEGER CHECK (days_per_week BETWEEN 1 AND 7),
    minutes_per_session INTEGER CHECK (minutes_per_session > 0),
    onboarding_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
    ON profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

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
    is_final BOOLEAN DEFAULT FALSE, -- TRUE only for slot 10 (mastery challenge)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: everyone can read path_slots (they're static curriculum data)
ALTER TABLE path_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view path slots"
    ON path_slots FOR SELECT
    USING (TRUE);

-- Seed the 10 path slots with placeholder values
-- XP values increase along the path; slot 10 is the mastery challenge
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
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    recipe_json JSONB NOT NULL, -- full recipe data from AI
    video_ids JSONB, -- cached YouTube video IDs for techniques
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, slot_id) -- one recipe per user per slot
);

ALTER TABLE user_recipes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own recipes"
    ON user_recipes FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own recipes"
    ON user_recipes FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- No update policy: recipes are immutable once generated

-- -----------------------------------------------------------------------------
-- check_ins: feedback after completing a recipe
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_ins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_recipe_id UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    difficulty_rating TEXT NOT NULL CHECK (difficulty_rating IN ('easy', 'ok', 'hard')),
    went_well TEXT, -- optional
    was_hard TEXT, -- optional
    is_repeat BOOLEAN DEFAULT FALSE, -- TRUE if this slot was already completed before
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE check_ins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own check-ins"
    ON check_ins FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own check-ins"
    ON check_ins FOR INSERT
    WITH CHECK (auth.uid() = user_id);

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
    -- Unique constraint ensures only one XP award per check-in, preventing race conditions
    UNIQUE (check_in_id)
);

ALTER TABLE xp_events ENABLE ROW LEVEL SECURITY;

-- Users can only SELECT their own XP events - NO INSERT/UPDATE/DELETE from clients
CREATE POLICY "Users can view own XP events"
    ON xp_events FOR SELECT
    USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for regular users
-- This ensures only service_role or SECURITY DEFINER functions can write

-- Index for efficient weekly cap calculation
CREATE INDEX idx_xp_events_user_created ON xp_events (user_id, created_at);
CREATE INDEX idx_xp_events_user_slot ON xp_events (user_id, slot_id);

-- -----------------------------------------------------------------------------
-- user_slot_completions: tracks which slots a user has completed at least once
-- Used to determine first vs repeat completion
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_slot_completions (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    first_completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, slot_id)
);

ALTER TABLE user_slot_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own completions"
    ON user_slot_completions FOR SELECT
    USING (auth.uid() = user_id);

-- No direct INSERT/UPDATE from clients - managed by XP function

-- -----------------------------------------------------------------------------
-- award_slot_xp: SECURITY DEFINER function to award XP safely
-- Called after a check-in is created. Handles:
-- - First completion: full XP
-- - Repeat completion: 50% XP (configurable)
-- - Weekly repeat cap: 100 XP (configurable)
-- - Concurrency: unique constraint + transaction ensures exactly one award
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION award_slot_xp(
    p_user_id UUID,
    p_check_in_id UUID,
    p_slot_id INTEGER
)
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
    v_slot_xp INTEGER;
    v_is_first BOOLEAN;
    v_repeat_percent INTEGER;
    v_weekly_cap INTEGER;
    v_weekly_repeat_used INTEGER;
    v_xp_to_award INTEGER;
    v_capped BOOLEAN := FALSE;
    v_week_start TIMESTAMPTZ;
BEGIN
    -- Get configurable values
    SELECT value INTO v_repeat_percent FROM xp_config WHERE key = 'repeat_xp_percent';
    SELECT value INTO v_weekly_cap FROM xp_config WHERE key = 'weekly_repeat_cap';
    
    -- Default fallbacks if config missing
    v_repeat_percent := COALESCE(v_repeat_percent, 50);
    v_weekly_cap := COALESCE(v_weekly_cap, 100);
    
    -- Get slot's base XP value
    SELECT xp_value INTO v_slot_xp FROM path_slots WHERE id = p_slot_id;
    
    IF v_slot_xp IS NULL THEN
        RAISE EXCEPTION 'Invalid slot_id: %', p_slot_id;
    END IF;
    
    -- Check if this is the first completion of this slot by this user
    -- Try to insert into user_slot_completions; if it already exists, it's a repeat
    BEGIN
        INSERT INTO user_slot_completions (user_id, slot_id)
        VALUES (p_user_id, p_slot_id);
        v_is_first := TRUE;
    EXCEPTION WHEN unique_violation THEN
        v_is_first := FALSE;
    END;
    
    -- Calculate XP to award
    IF v_is_first THEN
        -- First completion: full XP
        v_xp_to_award := v_slot_xp;
    ELSE
        -- Repeat completion: reduced XP, subject to weekly cap
        v_xp_to_award := (v_slot_xp * v_repeat_percent) / 100;
        
        -- Calculate start of current week (Monday 00:00 UTC)
        v_week_start := date_trunc('week', NOW());
        
        -- Sum repeat XP already earned this week
        SELECT COALESCE(SUM(e.xp_awarded), 0)
        INTO v_weekly_repeat_used
        FROM xp_events e
        WHERE e.user_id = p_user_id
          AND e.created_at >= v_week_start
          AND e.is_first_completion = FALSE;
        
        -- Apply weekly cap
        IF v_weekly_repeat_used >= v_weekly_cap THEN
            -- Already at or over cap
            v_xp_to_award := 0;
            v_capped := TRUE;
        ELSIF v_weekly_repeat_used + v_xp_to_award > v_weekly_cap THEN
            -- Partial award to reach cap exactly
            v_xp_to_award := v_weekly_cap - v_weekly_repeat_used;
            v_capped := TRUE;
        END IF;
    END IF;
    
    -- Insert XP event (unique constraint on check_in_id prevents duplicates from concurrent calls)
    INSERT INTO xp_events (user_id, check_in_id, slot_id, xp_awarded, is_first_completion)
    VALUES (p_user_id, p_check_in_id, p_slot_id, v_xp_to_award, v_is_first);
    
    -- Return results
    RETURN QUERY SELECT 
        v_xp_to_award,
        v_is_first,
        GREATEST(0, v_weekly_cap - v_weekly_repeat_used - v_xp_to_award)::INTEGER,
        v_capped;
END;
$$;

-- Revoke execute from public, grant only to authenticated (via service role or RPC)
REVOKE EXECUTE ON FUNCTION award_slot_xp FROM PUBLIC;
GRANT EXECUTE ON FUNCTION award_slot_xp TO authenticated;

-- -----------------------------------------------------------------------------
-- get_user_total_xp: helper to fetch a user's total XP
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_total_xp(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
BEGIN
    SELECT COALESCE(SUM(xp_awarded), 0)
    INTO v_total
    FROM xp_events
    WHERE user_id = p_user_id;
    
    RETURN v_total;
END;
$$;

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

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
