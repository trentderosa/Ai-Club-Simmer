-- =============================================================================
-- Simmer MVP - XP Formula Weights Migration
-- =============================================================================
-- This migration implements the team's final XP formula:
--   XP = max(1, round((steps*0.45 + ingredients*0.35 + cook_minutes*0.2) * 10))
--
-- Changes:
-- 1. Migrate xp_config.value from INTEGER to NUMERIC for decimal weights
-- 2. Add weight configs: steps_weight, ingredients_weight, cook_minutes_weight, xp_multiplier
-- 3. Add path_slots columns: steps, ingredients, cook_minutes
-- 4. Seed path_slots with recipe counts (placeholders marked for Ian review)
-- 5. Create recompute_slot_xp() function and triggers
-- 6. Fix update_updated_at search_path for Supabase advisor warning
--
-- IMPORTANT: xp_value is stored (computed by migration/recompute), NOT calculated
-- at award time. This ensures XP already earned in xp_events never shifts when
-- weights change.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Migrate xp_config.value from INTEGER to NUMERIC
-- This allows storing decimal weights like 0.45, 0.35, 0.2
-- Done safely: ALTER COLUMN with USING to preserve existing data
-- -----------------------------------------------------------------------------
ALTER TABLE xp_config
    ALTER COLUMN value TYPE NUMERIC USING value::NUMERIC;

-- Update the CHECK constraint for the new NUMERIC type
-- N2: Add upper bounds on weights (0-10 for weights, 0-1000 for multiplier) to catch misconfigs
ALTER TABLE xp_config DROP CONSTRAINT IF EXISTS xp_config_value_check;
ALTER TABLE xp_config ADD CONSTRAINT xp_config_value_check CHECK (value >= 0);
ALTER TABLE xp_config DROP CONSTRAINT IF EXISTS xp_config_weight_bounds;
ALTER TABLE xp_config ADD CONSTRAINT xp_config_weight_bounds CHECK (
    CASE 
        WHEN key IN ('steps_weight', 'ingredients_weight', 'cook_minutes_weight') THEN value <= 10
        WHEN key = 'xp_multiplier' THEN value <= 1000
        ELSE TRUE
    END
);

-- -----------------------------------------------------------------------------
-- 2. Add XP formula weight configs
-- Default weights: steps=0.45, ingredients=0.35, cook_minutes=0.2, multiplier=10
-- CHECK (value >= 0) is already on the column
-- -----------------------------------------------------------------------------
INSERT INTO xp_config (key, value, description) VALUES
    ('steps_weight', 0.45, 'Weight for number of steps in XP formula'),
    ('ingredients_weight', 0.35, 'Weight for number of ingredients in XP formula'),
    ('cook_minutes_weight', 0.2, 'Weight for cook time in minutes in XP formula'),
    ('xp_multiplier', 10, 'Scale multiplier applied to weighted sum before rounding')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;

-- -----------------------------------------------------------------------------
-- 3. Add recipe input columns to path_slots
-- These must come from fixed path_slots data, never from AI-generated recipes
-- or user input. Values are seeded below.
-- -----------------------------------------------------------------------------
ALTER TABLE path_slots
    ADD COLUMN IF NOT EXISTS steps INTEGER,
    ADD COLUMN IF NOT EXISTS ingredients INTEGER,
    ADD COLUMN IF NOT EXISTS cook_minutes INTEGER;

-- Add CHECK constraints for non-negative values
ALTER TABLE path_slots
    DROP CONSTRAINT IF EXISTS path_slots_steps_check,
    DROP CONSTRAINT IF EXISTS path_slots_ingredients_check,
    DROP CONSTRAINT IF EXISTS path_slots_cook_minutes_check;

ALTER TABLE path_slots
    ADD CONSTRAINT path_slots_steps_check CHECK (steps IS NULL OR steps >= 0),
    ADD CONSTRAINT path_slots_ingredients_check CHECK (ingredients IS NULL OR ingredients >= 0),
    ADD CONSTRAINT path_slots_cook_minutes_check CHECK (cook_minutes IS NULL OR cook_minutes >= 0);

-- -----------------------------------------------------------------------------
-- 4. Create recompute_slot_xp() function
-- Formula: XP = max(1, round((steps*w1 + ingredients*w2 + cook_minutes*w3) * multiplier))
-- This is called by triggers when inputs or config change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_slot_xp(p_slot_id INTEGER DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_steps_weight NUMERIC;
    v_ingredients_weight NUMERIC;
    v_cook_minutes_weight NUMERIC;
    v_multiplier NUMERIC;
BEGIN
    -- Get current weights from config
    SELECT value INTO v_steps_weight FROM xp_config WHERE key = 'steps_weight';
    SELECT value INTO v_ingredients_weight FROM xp_config WHERE key = 'ingredients_weight';
    SELECT value INTO v_cook_minutes_weight FROM xp_config WHERE key = 'cook_minutes_weight';
    SELECT value INTO v_multiplier FROM xp_config WHERE key = 'xp_multiplier';
    
    -- Use defaults if not set
    v_steps_weight := COALESCE(v_steps_weight, 0.45);
    v_ingredients_weight := COALESCE(v_ingredients_weight, 0.35);
    v_cook_minutes_weight := COALESCE(v_cook_minutes_weight, 0.2);
    v_multiplier := COALESCE(v_multiplier, 10);
    
    -- Update xp_value for specified slot or all slots with complete data
    UPDATE path_slots
    SET xp_value = GREATEST(1, ROUND(
        (COALESCE(steps, 0) * v_steps_weight +
         COALESCE(ingredients, 0) * v_ingredients_weight +
         COALESCE(cook_minutes, 0) * v_cook_minutes_weight) * v_multiplier
    ))::INTEGER
    WHERE (p_slot_id IS NULL OR id = p_slot_id)
      AND steps IS NOT NULL
      AND ingredients IS NOT NULL
      AND cook_minutes IS NOT NULL;
END;
$$;

-- S1: Revoke from PUBLIC, anon, and authenticated - only service role should call this
REVOKE EXECUTE ON FUNCTION recompute_slot_xp(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION recompute_slot_xp(INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION recompute_slot_xp(INTEGER) FROM authenticated;

-- -----------------------------------------------------------------------------
-- 5. Create recompute_all_slot_xp() for config changes
-- When a weight or multiplier changes, all slots need recomputation
-- -----------------------------------------------------------------------------
-- N4: Trigger functions don't need SECURITY DEFINER - they inherit the trigger's context
CREATE OR REPLACE FUNCTION recompute_all_slot_xp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Only recompute if a weight or multiplier key changed
    IF NEW.key IN ('steps_weight', 'ingredients_weight', 'cook_minutes_weight', 'xp_multiplier')
       AND (OLD.value IS DISTINCT FROM NEW.value) THEN
        PERFORM recompute_slot_xp(NULL);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xp_config_recompute_trigger ON xp_config;
CREATE TRIGGER xp_config_recompute_trigger
    AFTER UPDATE ON xp_config
    FOR EACH ROW
    EXECUTE FUNCTION recompute_all_slot_xp();

-- -----------------------------------------------------------------------------
-- 6. Create trigger for path_slots input changes
-- When steps, ingredients, or cook_minutes change, recompute that slot's XP
-- -----------------------------------------------------------------------------
-- N4: Trigger functions don't need SECURITY DEFINER
CREATE OR REPLACE FUNCTION recompute_slot_xp_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Recompute if any input column changed
    IF (OLD.steps IS DISTINCT FROM NEW.steps)
       OR (OLD.ingredients IS DISTINCT FROM NEW.ingredients)
       OR (OLD.cook_minutes IS DISTINCT FROM NEW.cook_minutes) THEN
        PERFORM recompute_slot_xp(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS path_slots_recompute_trigger ON path_slots;
CREATE TRIGGER path_slots_recompute_trigger
    AFTER UPDATE ON path_slots
    FOR EACH ROW
    EXECUTE FUNCTION recompute_slot_xp_on_change();

-- -----------------------------------------------------------------------------
-- 7. Seed path_slots with steps, ingredients, cook_minutes
-- 
-- Values are averages of two published beginner recipes per slot.
-- Salt, pepper and water are not counted as ingredients.
-- Time is published prep plus cook time.
-- Approved by Trent (2026-11-10).
--
-- XP formula: max(1, round((steps*0.45 + ingredients*0.35 + cook_minutes*0.2) * 10))
-- PostgreSQL ROUND(numeric) rounds halves away from zero.
-- -----------------------------------------------------------------------------

-- Slot 1: Knife Skills Salad
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=6, ingredients=10, cook_minutes=20
-- XP = max(1, round((6*0.45 + 10*0.35 + 20*0.2) * 10)) = round(102) = 102
UPDATE path_slots SET steps = 6, ingredients = 10, cook_minutes = 20 WHERE slot_order = 1;

-- Slot 2: Scrambled Eggs
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=7, ingredients=3, cook_minutes=10
-- XP = max(1, round((7*0.45 + 3*0.35 + 10*0.2) * 10)) = round(62) = 62
UPDATE path_slots SET steps = 7, ingredients = 3, cook_minutes = 10 WHERE slot_order = 2;

-- Slot 3: Pasta
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=4, ingredients=6, cook_minutes=18
-- XP = max(1, round((4*0.45 + 6*0.35 + 18*0.2) * 10)) = round(75) = 75
UPDATE path_slots SET steps = 4, ingredients = 6, cook_minutes = 18 WHERE slot_order = 3;

-- Slot 4: Stir-Fry
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=6, ingredients=13, cook_minutes=35
-- XP = max(1, round((6*0.45 + 13*0.35 + 35*0.2) * 10)) = round(142.5) = 143 (half away from zero)
UPDATE path_slots SET steps = 6, ingredients = 13, cook_minutes = 35 WHERE slot_order = 4;

-- Slot 5: Grilled Cheese
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=4, ingredients=3, cook_minutes=18
-- XP = max(1, round((4*0.45 + 3*0.35 + 18*0.2) * 10)) = round(64.5) = 65 (half away from zero)
UPDATE path_slots SET steps = 4, ingredients = 3, cook_minutes = 18 WHERE slot_order = 5;

-- Slot 6: Rice Bowl
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=6, ingredients=8, cook_minutes=25
-- XP = max(1, round((6*0.45 + 8*0.35 + 25*0.2) * 10)) = round(105) = 105
UPDATE path_slots SET steps = 6, ingredients = 8, cook_minutes = 25 WHERE slot_order = 6;

-- Slot 7: Sheet Pan
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=5, ingredients=11, cook_minutes=38
-- XP = max(1, round((5*0.45 + 11*0.35 + 38*0.2) * 10)) = round(136.5) = 137
UPDATE path_slots SET steps = 5, ingredients = 11, cook_minutes = 38 WHERE slot_order = 7;

-- Slot 8: Seared Chicken
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=5, ingredients=5, cook_minutes=20
-- XP = max(1, round((5*0.45 + 5*0.35 + 20*0.2) * 10)) = round(80) = 80
UPDATE path_slots SET steps = 5, ingredients = 5, cook_minutes = 20 WHERE slot_order = 8;

-- Slot 9: Soup
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=5, ingredients=13, cook_minutes=40
-- XP = max(1, round((5*0.45 + 13*0.35 + 40*0.2) * 10)) = round(148) = 148
UPDATE path_slots SET steps = 5, ingredients = 13, cook_minutes = 40 WHERE slot_order = 9;

-- Slot 10: Roast Chicken (mastery challenge)
-- Averages of two published beginner recipes (salt/pepper/water not counted; time = prep + cook). Approved by Trent.
-- steps=3, ingredients=2, cook_minutes=80
-- XP = max(1, round((3*0.45 + 2*0.35 + 80*0.2) * 10)) = round(180.5) = 181 (half away from zero)
UPDATE path_slots SET steps = 3, ingredients = 2, cook_minutes = 80 WHERE slot_order = 10;

-- Now recompute all XP values using the formula
SELECT recompute_slot_xp(NULL);

-- -----------------------------------------------------------------------------
-- 8. Fix update_updated_at search_path for Supabase advisor warning
-- Set explicit search_path to satisfy security best practices
-- DO NOT touch public.rls_auto_enable (other teammates own that)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Verification queries (commented out, for manual testing)
-- -----------------------------------------------------------------------------
-- SELECT slot_order, dish_name, steps, ingredients, cook_minutes, xp_value FROM path_slots ORDER BY slot_order;
-- SELECT key, value FROM xp_config WHERE key LIKE '%weight%' OR key = 'xp_multiplier';
