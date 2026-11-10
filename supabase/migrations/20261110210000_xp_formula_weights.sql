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
ALTER TABLE xp_config DROP CONSTRAINT IF EXISTS xp_config_value_check;
ALTER TABLE xp_config ADD CONSTRAINT xp_config_value_check CHECK (value >= 0);

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

-- N7 style: Revoke from PUBLIC and anon for belt-and-braces security
REVOKE EXECUTE ON FUNCTION recompute_slot_xp(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION recompute_slot_xp(INTEGER) FROM anon;

-- -----------------------------------------------------------------------------
-- 5. Create recompute_all_slot_xp() for config changes
-- When a weight or multiplier changes, all slots need recomputation
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_all_slot_xp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
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
CREATE OR REPLACE FUNCTION recompute_slot_xp_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
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
-- Data sources searched in repo:
-- - PRD.md: No specific recipe counts
-- - ai-server tests: Mock data only, not authoritative
-- - supabase/migrations: Only dish names, no counts
--
-- Slots 1-3 have reasonable estimates based on dish complexity.
-- Slots 4-10 are PLACEHOLDERS - need Ian's review with actual recipe data.
--
-- XP formula: max(1, round((steps*0.45 + ingredients*0.35 + cook_minutes*0.2) * 10))
-- -----------------------------------------------------------------------------

-- Slot 1: Knife Basics Salad - simple chopping exercise
-- steps=4 (wash, chop veggies, combine, dress), ingredients=5, cook_minutes=10
-- XP = max(1, round((4*0.45 + 5*0.35 + 10*0.2) * 10)) = max(1, round((1.8+1.75+2)*10)) = round(55.5) = 56
UPDATE path_slots SET steps = 4, ingredients = 5, cook_minutes = 10 WHERE slot_order = 1;

-- Slot 2: Scrambled Eggs - basic heat control
-- steps=5 (crack eggs, whisk, heat pan, scramble, plate), ingredients=4, cook_minutes=8
-- XP = max(1, round((5*0.45 + 4*0.35 + 8*0.2) * 10)) = max(1, round((2.25+1.4+1.6)*10)) = round(52.5) = 53
UPDATE path_slots SET steps = 5, ingredients = 4, cook_minutes = 8 WHERE slot_order = 2;

-- Slot 3: Pasta with Sauce - boiling and timing
-- steps=6 (boil water, cook pasta, make sauce, drain, combine, serve), ingredients=6, cook_minutes=20
-- XP = max(1, round((6*0.45 + 6*0.35 + 20*0.2) * 10)) = max(1, round((2.7+2.1+4)*10)) = round(88) = 88
UPDATE path_slots SET steps = 6, ingredients = 6, cook_minutes = 20 WHERE slot_order = 3;

-- Slot 4: Stir-Fry Vegetables -- PLACEHOLDER: needs Ian
-- Estimate: steps=7, ingredients=8, cook_minutes=15
-- XP = max(1, round((7*0.45 + 8*0.35 + 15*0.2) * 10)) = max(1, round((3.15+2.8+3)*10)) = round(89.5) = 90
UPDATE path_slots SET steps = 7, ingredients = 8, cook_minutes = 15 WHERE slot_order = 4;

-- Slot 5: Grilled Cheese -- PLACEHOLDER: needs Ian
-- Estimate: steps=4, ingredients=3, cook_minutes=10
-- XP = max(1, round((4*0.45 + 3*0.35 + 10*0.2) * 10)) = max(1, round((1.8+1.05+2)*10)) = round(48.5) = 49
UPDATE path_slots SET steps = 4, ingredients = 3, cook_minutes = 10 WHERE slot_order = 5;

-- Slot 6: Rice Bowl -- PLACEHOLDER: needs Ian
-- Estimate: steps=6, ingredients=7, cook_minutes=25
-- XP = max(1, round((6*0.45 + 7*0.35 + 25*0.2) * 10)) = max(1, round((2.7+2.45+5)*10)) = round(101.5) = 102
UPDATE path_slots SET steps = 6, ingredients = 7, cook_minutes = 25 WHERE slot_order = 6;

-- Slot 7: Sheet Pan Vegetables -- PLACEHOLDER: needs Ian
-- Estimate: steps=5, ingredients=6, cook_minutes=30
-- XP = max(1, round((5*0.45 + 6*0.35 + 30*0.2) * 10)) = max(1, round((2.25+2.1+6)*10)) = round(103.5) = 104
UPDATE path_slots SET steps = 5, ingredients = 6, cook_minutes = 30 WHERE slot_order = 7;

-- Slot 8: Seared Chicken Breast -- PLACEHOLDER: needs Ian
-- Estimate: steps=6, ingredients=5, cook_minutes=25
-- XP = max(1, round((6*0.45 + 5*0.35 + 25*0.2) * 10)) = max(1, round((2.7+1.75+5)*10)) = round(94.5) = 95
UPDATE path_slots SET steps = 6, ingredients = 5, cook_minutes = 25 WHERE slot_order = 8;

-- Slot 9: Simple Soup -- PLACEHOLDER: needs Ian
-- Estimate: steps=7, ingredients=9, cook_minutes=35
-- XP = max(1, round((7*0.45 + 9*0.35 + 35*0.2) * 10)) = max(1, round((3.15+3.15+7)*10)) = round(133) = 133
UPDATE path_slots SET steps = 7, ingredients = 9, cook_minutes = 35 WHERE slot_order = 9;

-- Slot 10: Roast Chicken (mastery challenge) -- PLACEHOLDER: needs Ian
-- Estimate: steps=8, ingredients=10, cook_minutes=75
-- XP = max(1, round((8*0.45 + 10*0.35 + 75*0.2) * 10)) = max(1, round((3.6+3.5+15)*10)) = round(221) = 221
UPDATE path_slots SET steps = 8, ingredients = 10, cook_minutes = 75 WHERE slot_order = 10;

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
