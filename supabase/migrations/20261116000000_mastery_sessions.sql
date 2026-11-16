-- =============================================================================
-- Simmer - Server-side mastery sessions (F8 / PRD open question 4 follow-up)
-- =============================================================================
-- NEW migration only. Does not edit merged migrations.
--
-- Before this migration the mastery reveal counts on a check-in were
-- client-reported: anyone could send revealed_steps = 0 and earn the mastery
-- badge without cooking blind, and the full final recipe (hidden steps
-- included) was readable from user_recipes.
--
-- After it:
--   1. The ai-server starts (or resumes) a mastery session for the final slot.
--      The session stores which step indices start hidden and which the user
--      has revealed. Only the ai-server (service role) can read or write it.
--   2. The text of a hidden step is served only by reveal_mastery_step(), which
--      records the reveal first. The ai-server masks hidden steps everywhere
--      else, and clients can no longer read recipe_json from user_recipes.
--   3. A check-in's hidden_steps / revealed_steps are copied from the session
--      by a trigger. Counts sent without a session are rejected.
--   4. Clients can no longer insert check_ins directly. Every check-in goes
--      through the ai-server (which already was the only caller), so the path,
--      badges and the mastery rule cannot be bypassed through PostgREST.
--
-- Unchanged: the badge rule itself (earliest final-slot check-in with
-- hidden_steps IS NOT NULL AND revealed_steps = 0, from
-- 20261115210000_mastery_badge_zero_reveals.sql). New rows can only get
-- counts from a session, so that rule is now server-verified. Rows written
-- before this migration keep their (client-reported) counts.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. mastery_sessions: one cook of the final slot in challenge mode
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mastery_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_recipe_id UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    slot_id INTEGER NOT NULL REFERENCES path_slots(id) ON DELETE CASCADE,
    -- 0-based step indices that start hidden (every non-safety step)
    hidden_step_indices INTEGER[] NOT NULL,
    -- 0-based step indices the user revealed; always a subset of hidden
    revealed_step_indices INTEGER[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mastery_sessions_hidden_size CHECK (cardinality(hidden_step_indices) <= 30),
    CONSTRAINT mastery_sessions_revealed_subset CHECK (revealed_step_indices <@ hidden_step_indices)
);

CREATE INDEX IF NOT EXISTS idx_mastery_sessions_user_slot
    ON mastery_sessions (user_id, slot_id, created_at DESC);

ALTER TABLE mastery_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: clients cannot see or change sessions at all.
REVOKE ALL ON mastery_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON mastery_sessions TO service_role;

-- -----------------------------------------------------------------------------
-- 2. check_ins.mastery_session_id: each session backs at most one check-in
-- -----------------------------------------------------------------------------
ALTER TABLE check_ins
    ADD COLUMN IF NOT EXISTS mastery_session_id UUID
        REFERENCES mastery_sessions(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_ins_mastery_session_id_key'
    ) THEN
        ALTER TABLE check_ins
            ADD CONSTRAINT check_ins_mastery_session_id_key UNIQUE (mastery_session_id);
    END IF;
END
$$;

-- Reveal counts come only from a session. Named so it fires before
-- check_ins_mastery_only_on_final (BEFORE triggers run in name order), which
-- then still enforces "final slot only" on the copied counts.
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

DROP TRIGGER IF EXISTS check_ins_apply_mastery_session ON check_ins;
CREATE TRIGGER check_ins_apply_mastery_session
    BEFORE INSERT OR UPDATE ON check_ins
    FOR EACH ROW
    EXECUTE FUNCTION check_ins_apply_mastery_session();

-- -----------------------------------------------------------------------------
-- 3. RPCs (service role only)
-- Errors use RAISE with a stable code as the message so the ai-server can map
-- them: SLOT_NOT_FINAL, RECIPE_NOT_FOUND, SLOT_LOCKED, MASTERY_SESSION_NOT_FOUND,
-- MASTERY_SESSION_USED, STEP_NOT_HIDDEN.
-- -----------------------------------------------------------------------------

-- Hidden indices for a recipe: every step whose isSafetyStep is not true.
CREATE OR REPLACE FUNCTION mastery_hidden_step_indices(p_recipe JSONB)
RETURNS INTEGER[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT COALESCE(array_agg((s.ord - 1)::INTEGER ORDER BY s.ord), '{}')
    FROM jsonb_array_elements(COALESCE(p_recipe->'steps', '[]'::jsonb)) WITH ORDINALITY AS s(step, ord)
    WHERE COALESCE((s.step->>'isSafetyStep')::BOOLEAN, FALSE) = FALSE;
$$;

-- Steps the user has revealed, as a JSON object keyed by index ("3": {...}).
CREATE OR REPLACE FUNCTION mastery_revealed_steps_json(p_recipe JSONB, p_indices INTEGER[])
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT COALESCE(jsonb_object_agg(i::TEXT, p_recipe->'steps'->i), '{}'::jsonb)
    FROM unnest(p_indices) AS i;
$$;

-- Resume the user's open session for the slot, or start a new one. A session
-- is open until a check-in uses it, so restarting the app (or calling this
-- again) cannot reset the reveal count.
CREATE OR REPLACE FUNCTION start_mastery_session(p_user_id UUID, p_slot_id INTEGER)
RETURNS TABLE (
    session_id UUID,
    hidden_step_indices INTEGER[],
    revealed_step_indices INTEGER[],
    revealed_steps JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_recipe user_recipes%ROWTYPE;
    v_session mastery_sessions%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM path_slots s WHERE s.id = p_slot_id AND COALESCE(s.is_final, FALSE)) THEN
        RAISE EXCEPTION 'SLOT_NOT_FINAL';
    END IF;

    -- Locks the recipe row so two concurrent starts cannot both create a session.
    SELECT * INTO v_recipe
    FROM user_recipes ur
    WHERE ur.user_id = p_user_id AND ur.slot_id = p_slot_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RECIPE_NOT_FOUND';
    END IF;

    IF NOT is_slot_unlocked(p_user_id, p_slot_id) THEN
        RAISE EXCEPTION 'SLOT_LOCKED';
    END IF;

    SELECT ms.* INTO v_session
    FROM mastery_sessions ms
    WHERE ms.user_id = p_user_id
      AND ms.slot_id = p_slot_id
      AND ms.user_recipe_id = v_recipe.id
      AND NOT EXISTS (SELECT 1 FROM check_ins c WHERE c.mastery_session_id = ms.id)
    ORDER BY ms.created_at DESC, ms.id DESC
    LIMIT 1;

    IF NOT FOUND THEN
        INSERT INTO mastery_sessions (user_id, user_recipe_id, slot_id, hidden_step_indices)
        VALUES (p_user_id, v_recipe.id, p_slot_id, mastery_hidden_step_indices(v_recipe.recipe_json))
        RETURNING * INTO v_session;
    END IF;

    RETURN QUERY SELECT
        v_session.id,
        v_session.hidden_step_indices,
        v_session.revealed_step_indices,
        mastery_revealed_steps_json(v_recipe.recipe_json, v_session.revealed_step_indices);
END;
$$;

-- Record a reveal (idempotent) and return that step's full content.
CREATE OR REPLACE FUNCTION reveal_mastery_step(p_user_id UUID, p_session_id UUID, p_step_index INTEGER)
RETURNS TABLE (
    step JSONB,
    hidden_step_indices INTEGER[],
    revealed_step_indices INTEGER[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session mastery_sessions%ROWTYPE;
    v_recipe JSONB;
BEGIN
    SELECT ms.* INTO v_session
    FROM mastery_sessions ms
    WHERE ms.id = p_session_id AND ms.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'MASTERY_SESSION_NOT_FOUND';
    END IF;

    IF EXISTS (SELECT 1 FROM check_ins c WHERE c.mastery_session_id = v_session.id) THEN
        RAISE EXCEPTION 'MASTERY_SESSION_USED';
    END IF;

    IF p_step_index IS NULL OR NOT (p_step_index = ANY (v_session.hidden_step_indices)) THEN
        RAISE EXCEPTION 'STEP_NOT_HIDDEN';
    END IF;

    IF NOT (p_step_index = ANY (v_session.revealed_step_indices)) THEN
        UPDATE mastery_sessions ms
        SET revealed_step_indices = (
            SELECT array_agg(i ORDER BY i)
            FROM unnest(array_append(ms.revealed_step_indices, p_step_index)) AS i
        )
        WHERE ms.id = v_session.id
        RETURNING * INTO v_session;
    END IF;

    SELECT ur.recipe_json INTO v_recipe FROM user_recipes ur WHERE ur.id = v_session.user_recipe_id;

    RETURN QUERY SELECT
        v_recipe->'steps'->p_step_index,
        v_session.hidden_step_indices,
        v_session.revealed_step_indices;
END;
$$;

REVOKE EXECUTE ON FUNCTION check_ins_apply_mastery_session() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mastery_hidden_step_indices(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mastery_revealed_steps_json(JSONB, INTEGER[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION start_mastery_session(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reveal_mastery_step(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION start_mastery_session(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION reveal_mastery_step(UUID, UUID, INTEGER) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Close the client-side bypasses
-- -----------------------------------------------------------------------------
-- Check-ins are written only by the ai-server (service role). A direct client
-- insert could otherwise complete slots and earn badges without the server.
DROP POLICY IF EXISTS "Users can insert own check-ins with valid recipe" ON check_ins;
REVOKE INSERT ON check_ins FROM anon, authenticated;

-- Clients may still see which recipes exist (the app reads user_recipes.id),
-- but not recipe_json: the final slot's hidden steps are served only on reveal.
REVOKE SELECT ON user_recipes FROM anon, authenticated;
GRANT SELECT (id, user_id, slot_id, video_ids, created_at) ON user_recipes TO authenticated;
