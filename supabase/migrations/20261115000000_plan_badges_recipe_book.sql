-- =============================================================================
-- Simmer MVP - Plan (F2), mastery check-in fields (F8), badges (F9),
-- recipe book (F10), and technique video cache (F4)
-- =============================================================================
-- Design: the plan, badges and recipe book are DERIVED from check_ins, not
-- stored in their own tables. A slot is "done" once the user has at least one
-- check-in for it (PRD: "Finishing a slot (cook + check-in) unlocks the next
-- one"). Deriving them means:
--   - a badge can only be earned once (it is a fact about the first check-in),
--   - a recipe appears in the recipe book only once,
--   - nothing can drift out of sync, and a failed XP award (see the reconcile
--     job) never blocks the path or badges.
--
-- Client-facing RPCs take NO user id; they use auth.uid() (same pattern as
-- get_user_total_xp). The per-user helpers that take a user id are for the
-- service role only.
--
-- Open product choices (flagged in PRD open questions):
--   - suggested sessions/week formula (F2), see get_plan_summary_for_user
--   - every slot-10 check-in counts as passing the mastery challenge (F8, per
--     PRD); reveal counts are stored so a reveal limit can be added later.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. F8: mastery challenge reveal counts on check_ins
-- Only meaningful for the final slot. Both set or both NULL; revealed <= hidden.
-- -----------------------------------------------------------------------------
ALTER TABLE check_ins
    ADD COLUMN IF NOT EXISTS hidden_steps INTEGER,
    ADD COLUMN IF NOT EXISTS revealed_steps INTEGER;

ALTER TABLE check_ins DROP CONSTRAINT IF EXISTS check_ins_mastery_counts_check;
ALTER TABLE check_ins ADD CONSTRAINT check_ins_mastery_counts_check CHECK (
    (hidden_steps IS NULL AND revealed_steps IS NULL)
    OR (
        -- explicit NOT NULLs: a CHECK that evaluates to NULL passes
        hidden_steps IS NOT NULL
        AND revealed_steps IS NOT NULL
        AND hidden_steps BETWEEN 0 AND 30
        AND revealed_steps BETWEEN 0 AND 30
        AND revealed_steps <= hidden_steps
    )
);

-- Reveal counts are only allowed on the final (mastery) slot.
CREATE OR REPLACE FUNCTION check_ins_mastery_only_on_final()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.hidden_steps IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM path_slots s WHERE s.id = NEW.slot_id AND s.is_final
    ) THEN
        RAISE EXCEPTION 'hidden_steps/revealed_steps are only allowed for the mastery slot';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_ins_mastery_only_on_final ON check_ins;
CREATE TRIGGER check_ins_mastery_only_on_final
    BEFORE INSERT OR UPDATE OF hidden_steps, revealed_steps, slot_id ON check_ins
    FOR EACH ROW
    EXECUTE FUNCTION check_ins_mastery_only_on_final();

CREATE INDEX IF NOT EXISTS idx_check_ins_user_slot_created
    ON check_ins (user_id, slot_id, created_at, id);

-- -----------------------------------------------------------------------------
-- 2. F9: badge catalog (static, like path_slots)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS badges (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('completion', 'mastery', 'path_milestone')),
    slot_id INTEGER REFERENCES path_slots(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    CONSTRAINT badges_slot_matches_kind CHECK (
        (kind = 'path_milestone' AND slot_id IS NULL)
        OR (kind <> 'path_milestone' AND slot_id IS NOT NULL)
    )
);

ALTER TABLE badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view badges" ON badges;
CREATE POLICY "Anyone can view badges"
    ON badges FOR SELECT
    USING (TRUE);

-- One completion badge per non-final slot, one mastery badge for the final
-- slot, and one path milestone badge. Names are placeholders for Ian
-- (gamification owner) to rename; codes are stable.
INSERT INTO badges (code, name, description, kind, slot_id, sort_order)
SELECT
    'complete_slot_' || s.slot_order,
    s.dish_name,
    'Cooked ' || s.dish_name || ' and checked in.',
    'completion',
    s.id,
    s.slot_order
FROM path_slots s
WHERE NOT s.is_final
ON CONFLICT (code) DO NOTHING;

INSERT INTO badges (code, name, description, kind, slot_id, sort_order)
SELECT
    'mastery',
    s.dish_name || ' Mastery',
    'Passed the mastery challenge: cooked ' || s.dish_name || ' with the steps hidden.',
    'mastery',
    s.id,
    s.slot_order
FROM path_slots s
WHERE s.is_final
ON CONFLICT (code) DO NOTHING;

INSERT INTO badges (code, name, description, kind, slot_id, sort_order)
VALUES (
    'path_weeknight_basics',
    'Weeknight Basics Graduate',
    'Finished all 10 recipes on the Weeknight basics path.',
    'path_milestone',
    NULL,
    100
)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. F4: technique video cache (service role only)
-- One YouTube search per distinct technique, shared across all users, to save
-- quota (~100 searches/day on the free tier). video_id NULL caches "no result".
-- Clients read video ids from user_recipes.video_ids, never from this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technique_videos (
    technique_key TEXT PRIMARY KEY CHECK (char_length(technique_key) BETWEEN 1 AND 100),
    search_query TEXT NOT NULL,
    video_id TEXT CHECK (video_id IS NULL OR video_id ~ '^[A-Za-z0-9_-]{6,20}$'),
    video_title TEXT,
    channel_title TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE technique_videos ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

-- -----------------------------------------------------------------------------
-- 4. Per-user derived state (service role / internal only)
-- SECURITY INVOKER: callers still need to see the rows. Client roles cannot
-- EXECUTE these; they use the get_my_* wrappers below.
-- -----------------------------------------------------------------------------

-- First check-in per slot for a user = the moment the slot was completed.
CREATE OR REPLACE FUNCTION first_check_ins_for_user(p_user_id UUID)
RETURNS TABLE (slot_id INTEGER, check_in_id UUID, completed_at TIMESTAMPTZ, times_completed INTEGER)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.slot_id)
        c.slot_id,
        c.id,
        c.created_at,
        (COUNT(*) OVER (PARTITION BY c.slot_id))::INTEGER
    FROM check_ins c
    WHERE c.user_id = p_user_id
    ORDER BY c.slot_id, c.created_at, c.id;
$$;

-- F2: the 10 slots with done / current / locked.
-- current = the lowest-order slot that is not done; everything after is locked.
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
        s.dish_name,
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
    ORDER BY s.slot_order;
$$;

-- F2 + F7: header numbers for the plan screen.
--
-- suggested_sessions_per_week (PROPOSED rule, PRD open question 11):
--   weekly_minutes = days_per_week * minutes_per_session
--   avg_minutes    = average cook_minutes of the remaining slots
--                    (all slots once the path is finished)
--   suggested      = clamp(floor(weekly_minutes / avg_minutes), 1, days_per_week)
-- NULL when the profile has no schedule yet.
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
    SELECT COALESCE(SUM(e.xp_awarded), 0)::INTEGER INTO v_total_xp
    FROM xp_events e WHERE e.user_id = p_user_id;

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

-- F9: every badge with whether (and by which check-in) the user earned it.
CREATE OR REPLACE FUNCTION get_badges_for_user(p_user_id UUID)
RETURNS TABLE (
    code TEXT,
    name TEXT,
    description TEXT,
    kind TEXT,
    slot_id INTEGER,
    sort_order INTEGER,
    earned BOOLEAN,
    earned_at TIMESTAMPTZ,
    earned_check_in_id UUID
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH done AS (
        SELECT * FROM first_check_ins_for_user(p_user_id)
    ),
    -- The milestone is earned by the check-in that completed the last
    -- missing slot, i.e. the latest of the per-slot first check-ins.
    milestone AS (
        SELECT d.check_in_id, d.completed_at
        FROM done d
        WHERE (SELECT COUNT(*) FROM done) = (SELECT COUNT(*) FROM path_slots)
        ORDER BY d.completed_at DESC, d.check_in_id DESC
        LIMIT 1
    )
    SELECT
        b.code,
        b.name,
        b.description,
        b.kind,
        b.slot_id,
        b.sort_order,
        CASE WHEN b.kind = 'path_milestone'
             THEN EXISTS (SELECT 1 FROM milestone)
             ELSE d.check_in_id IS NOT NULL END,
        CASE WHEN b.kind = 'path_milestone'
             THEN (SELECT completed_at FROM milestone)
             ELSE d.completed_at END,
        CASE WHEN b.kind = 'path_milestone'
             THEN (SELECT check_in_id FROM milestone)
             ELSE d.check_in_id END
    FROM badges b
    LEFT JOIN done d ON d.slot_id = b.slot_id
    ORDER BY b.sort_order, b.code;
$$;

-- F10: one entry per completed slot. The final slot is Mastered (passing the
-- mastery challenge = completing its check-in, PRD F8).
CREATE OR REPLACE FUNCTION get_recipe_book_for_user(p_user_id UUID)
RETURNS TABLE (
    slot_id INTEGER,
    slot_order INTEGER,
    dish_name TEXT,
    user_recipe_id UUID,
    recipe_title TEXT,
    label TEXT,
    added_at TIMESTAMPTZ,
    times_cooked INTEGER
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        s.id,
        s.slot_order,
        s.dish_name,
        ur.id,
        COALESCE(ur.recipe_json->>'title', s.dish_name),
        CASE WHEN s.is_final THEN 'mastered' ELSE 'completed' END,
        d.completed_at,
        d.times_completed
    FROM first_check_ins_for_user(p_user_id) d
    JOIN path_slots s ON s.id = d.slot_id
    LEFT JOIN user_recipes ur ON ur.user_id = p_user_id AND ur.slot_id = s.id
    ORDER BY s.slot_order;
$$;

-- -----------------------------------------------------------------------------
-- 5. Service-role RPCs for the ai-server
-- -----------------------------------------------------------------------------

-- Path gating (F2): may this user start (generate a recipe for) this slot?
-- Done slots stay open so they can be repeated; the current slot is open;
-- locked slots are not.
CREATE OR REPLACE FUNCTION is_slot_unlocked(p_user_id UUID, p_slot_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT p.status <> 'locked'
         FROM get_plan_for_user(p_user_id) p
         WHERE p.slot_id = p_slot_id),
        FALSE
    );
$$;

-- F9 celebration: badges that THIS check-in earned (empty for repeats).
-- Derives the user from the check-in row, like award_slot_xp.
CREATE OR REPLACE FUNCTION get_badges_earned_by_check_in(p_check_in_id UUID)
RETURNS TABLE (code TEXT, name TEXT, description TEXT, kind TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT c.user_id INTO v_user_id FROM check_ins c WHERE c.id = p_check_in_id;
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid or non-existent check_in_id: %', p_check_in_id;
    END IF;

    RETURN QUERY
    SELECT b.code, b.name, b.description, b.kind
    FROM get_badges_for_user(v_user_id) b
    WHERE b.earned_check_in_id = p_check_in_id
    ORDER BY b.sort_order, b.code;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Client RPCs (authenticated only, no user id parameter)
-- SECURITY DEFINER so they can call the internal helpers above, which client
-- roles cannot EXECUTE. The user is always auth.uid(), so a caller can never
-- read another user's plan, badges or recipe book.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_my_plan();

CREATE FUNCTION get_my_plan()
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    RETURN QUERY SELECT * FROM get_plan_for_user(auth.uid());
END;
$$;

DROP FUNCTION IF EXISTS get_my_plan_summary();
CREATE FUNCTION get_my_plan_summary()
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
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    RETURN QUERY SELECT * FROM get_plan_summary_for_user(auth.uid());
END;
$$;

DROP FUNCTION IF EXISTS get_my_badges();
CREATE FUNCTION get_my_badges()
RETURNS TABLE (
    code TEXT,
    name TEXT,
    description TEXT,
    kind TEXT,
    slot_id INTEGER,
    sort_order INTEGER,
    earned BOOLEAN,
    earned_at TIMESTAMPTZ
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
    RETURN QUERY
    SELECT b.code, b.name, b.description, b.kind, b.slot_id, b.sort_order, b.earned, b.earned_at
    FROM get_badges_for_user(auth.uid()) b;
END;
$$;

DROP FUNCTION IF EXISTS get_my_recipe_book();
CREATE FUNCTION get_my_recipe_book()
RETURNS TABLE (
    slot_id INTEGER,
    slot_order INTEGER,
    dish_name TEXT,
    user_recipe_id UUID,
    recipe_title TEXT,
    label TEXT,
    added_at TIMESTAMPTZ,
    times_cooked INTEGER
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

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------
-- Internal / service-role helpers: no client EXECUTE.
REVOKE EXECUTE ON FUNCTION first_check_ins_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_plan_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_plan_summary_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_badges_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_recipe_book_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_slot_unlocked(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_badges_earned_by_check_in(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION check_ins_mastery_only_on_final() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION first_check_ins_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_plan_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_plan_summary_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_badges_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_recipe_book_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION is_slot_unlocked(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION get_badges_earned_by_check_in(UUID) TO service_role;

-- Client RPCs: authenticated only.
REVOKE EXECUTE ON FUNCTION get_my_plan() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_my_plan_summary() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_my_badges() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_my_recipe_book() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_plan_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_badges() TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_recipe_book() TO authenticated;

-- Tables: catalogs are read-only for clients; the video cache is invisible.
REVOKE INSERT, UPDATE, DELETE ON badges FROM anon, authenticated;
REVOKE ALL ON technique_videos FROM anon, authenticated;

-- Clients may insert check-ins (RLS-checked) but must not be able to rewrite
-- history: a backdated or moved check-in would change badges and the plan.
REVOKE UPDATE, DELETE ON check_ins FROM anon, authenticated;
