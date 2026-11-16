-- =============================================================================
-- Simmer - Allow deleting a mastery session that backs a check-in
-- =============================================================================
-- NEW migration only. Does not edit merged migrations.
--
-- 20261116000000_mastery_sessions.sql added check_ins.mastery_session_id
-- with ON DELETE SET NULL, and a BEFORE UPDATE trigger that rejected any
-- change to that column (or the copied reveal counts). Deleting a
-- mastery_sessions row — which happens when an auth user or a user_recipes
-- row is deleted, because those FKs CASCADE — tries to null the session
-- link first. The trigger then aborted the whole delete, so account or
-- recipe deletion could fail.
--
-- This migration lets the trigger allow that FK-driven nulling: the session
-- row is already gone, only mastery_session_id is cleared, and the copied
-- counts stay put. A direct UPDATE that clears the link while the session
-- still exists (or that changes the counts) is still rejected.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_ins_apply_mastery_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_session mastery_sessions%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.mastery_session_id IS DISTINCT FROM OLD.mastery_session_id
           OR NEW.hidden_steps IS DISTINCT FROM OLD.hidden_steps
           OR NEW.revealed_steps IS DISTINCT FROM OLD.revealed_steps THEN
            -- FK ON DELETE SET NULL: the session was deleted, so only the
            -- link is cleared. The copied counts must stay as they were.
            IF NEW.mastery_session_id IS NULL
               AND OLD.mastery_session_id IS NOT NULL
               AND NEW.hidden_steps IS NOT DISTINCT FROM OLD.hidden_steps
               AND NEW.revealed_steps IS NOT DISTINCT FROM OLD.revealed_steps
               AND NOT EXISTS (
                   SELECT 1 FROM mastery_sessions WHERE id = OLD.mastery_session_id
               ) THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'mastery fields on a check-in cannot be changed';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.mastery_session_id IS NULL THEN
        IF NEW.hidden_steps IS NOT NULL OR NEW.revealed_steps IS NOT NULL THEN
            RAISE EXCEPTION 'mastery reveal counts must come from a mastery session';
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO v_session FROM mastery_sessions WHERE id = NEW.mastery_session_id;
    IF NOT FOUND
       OR v_session.user_id <> NEW.user_id
       OR v_session.slot_id <> NEW.slot_id
       OR v_session.user_recipe_id <> NEW.user_recipe_id THEN
        RAISE EXCEPTION 'mastery session does not match this check-in';
    END IF;

    NEW.hidden_steps := cardinality(v_session.hidden_step_indices);
    NEW.revealed_steps := cardinality(v_session.revealed_step_indices);
    RETURN NEW;
END;
$$;
