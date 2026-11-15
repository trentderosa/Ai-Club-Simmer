-- =============================================================================
-- Simmer - Mastery badge requires zero reveals (F8 / Q4)
-- =============================================================================
-- NEW migration only. Does not edit merged migrations.
-- Kai applies this to prod only after this PR is merged. Do not apply it here.
--
-- Trent decided on Nov 15, 2026: the mastery badge is awarded only when a
-- final-slot check-in has revealed_steps = 0 (and a mastery payload is
-- present: hidden_steps IS NOT NULL). A missing payload earns no badge.
-- Finishing slot 10 with any reveals still completes the slot, awards normal
-- XP, and can earn the path graduate badge. XP is not affected.
--
-- Reveal counts are client-reported, so a modified client can send
-- revealed_steps: 0 without cooking blind. The planned follow-up is to serve
-- hidden step text only on reveal. Badge rules are Ian's area; Ian still
-- needs to OK this zero-reveals rule.
-- =============================================================================

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
    ),
    -- Mastery badge: earliest final-slot check-in with a payload and
    -- revealed_steps = 0. Missing or non-zero reveals do not count.
    -- A later perfect run can still earn it.
    mastery_pass AS (
        SELECT DISTINCT ON (c.slot_id)
            c.slot_id,
            c.id AS check_in_id,
            c.created_at AS completed_at
        FROM check_ins c
        JOIN path_slots s ON s.id = c.slot_id AND COALESCE(s.is_final, FALSE)
        WHERE c.user_id = p_user_id
          AND c.hidden_steps IS NOT NULL
          AND c.revealed_steps = 0
        ORDER BY c.slot_id, c.created_at, c.id
    )
    SELECT
        b.code,
        b.name,
        b.description,
        b.kind,
        b.slot_id,
        b.sort_order,
        CASE
            WHEN b.kind = 'path_milestone' THEN EXISTS (SELECT 1 FROM milestone)
            WHEN b.kind = 'mastery' THEN m.check_in_id IS NOT NULL
            ELSE d.check_in_id IS NOT NULL
        END,
        CASE
            WHEN b.kind = 'path_milestone' THEN (SELECT completed_at FROM milestone)
            WHEN b.kind = 'mastery' THEN m.completed_at
            ELSE d.completed_at
        END,
        CASE
            WHEN b.kind = 'path_milestone' THEN (SELECT check_in_id FROM milestone)
            WHEN b.kind = 'mastery' THEN m.check_in_id
            ELSE d.check_in_id
        END
    FROM badges b
    LEFT JOIN done d ON d.slot_id = b.slot_id
    LEFT JOIN mastery_pass m ON m.slot_id = b.slot_id
    ORDER BY b.sort_order, b.code;
$$;
