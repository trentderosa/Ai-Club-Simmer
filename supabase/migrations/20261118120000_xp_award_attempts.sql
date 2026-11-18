-- XP reconcile attempt tracking (server-only).
--
-- The reconcile job (ai-server/src/jobs) retries check-ins that have no XP
-- row. Before this, every run took the oldest `batchLimit` missing check-ins,
-- so 100+ check-ins that keep failing starved every newer one forever.
--
-- This adds:
--   * xp_award_attempts: one row per check-in whose award failed, with an
--     attempt count, the last attempt time and a short reason code.
--   * get_xp_reconcile_candidates: missing-XP check-ins in a window, never
--     attempted first, then least recently attempted, then oldest; rows at or
--     over the max attempts are left out. A row with n failed attempts is
--     eligible again only after last_attempt_at + base * 2^(n-1) minutes,
--     capped at 24 hours (base = p_retry_base_minutes), so a short outage
--     can't burn all attempts in minutes.
--   * count_xp_reconcile_given_up / list_xp_reconcile_given_up: the in-window
--     missing check-ins that are over the max attempts (count, and ids so a
--     person can act on them).
--   * record_xp_award_attempt: bump the attempt row after a failed award.
--
-- Service-role only (ai-server). RLS is on with no client policies, and
-- anon/authenticated have no table or EXECUTE access. XP rules, caps and
-- UNIQUE(check_in_id) are untouched; no XP is computed here.
--
-- check_in_id has no foreign key: it points at check_ins.id for kind 'path'
-- and generated_recipe_check_ins.id for kind 'generated', and one column
-- cannot reference two tables. AFTER DELETE triggers on both tables remove the
-- attempt row instead, which is what ON DELETE CASCADE would do. A row for a
-- check-in that was later awarded is kept (harmless history); the scan
-- ignores it because the anti-join only returns check-ins with no XP row.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

CREATE TABLE IF NOT EXISTS xp_award_attempts (
    check_in_id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'generated')),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_reason TEXT NOT NULL DEFAULT 'unknown' CHECK (char_length(last_reason) <= 40)
);

ALTER TABLE xp_award_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

REVOKE ALL ON xp_award_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON xp_award_attempts TO service_role;

-- -----------------------------------------------------------------------------
-- Candidates: never attempted first, then oldest last attempt, then oldest
-- check-in. Rows with attempts >= p_max_attempts are excluded.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_xp_reconcile_candidates(
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_limit INTEGER,
    p_max_attempts INTEGER,
    p_retry_base_minutes INTEGER
)
RETURNS TABLE (
    check_in_id UUID,
    slot_id INTEGER,
    created_at TIMESTAMPTZ,
    kind TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT m.id, m.slot_id, m.created_at, m.kind
    FROM (
        SELECT c.id, c.slot_id, c.created_at, 'slot'::text AS kind
        FROM check_ins c
        WHERE c.created_at >= p_from
          AND c.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
        UNION ALL
        SELECT g.id, NULL::integer, g.created_at, 'generated'::text
        FROM generated_recipe_check_ins g
        WHERE g.created_at >= p_from
          AND g.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM generated_recipe_xp_events e WHERE e.check_in_id = g.id)
    ) m
    LEFT JOIN xp_award_attempts a ON a.check_in_id = m.id
    WHERE COALESCE(a.attempts, 0) < p_max_attempts
      AND (
        a.check_in_id IS NULL
        OR a.last_attempt_at
           + LEAST(p_retry_base_minutes::numeric * power(2, LEAST(a.attempts, 30) - 1), 1440)
             * INTERVAL '1 minute'
           <= NOW()
      )
    ORDER BY (a.check_in_id IS NOT NULL) ASC,
             a.last_attempt_at ASC NULLS FIRST,
             m.created_at ASC,
             m.id ASC
    LIMIT LEAST(GREATEST(p_limit, 0), 1000);
$$;

CREATE OR REPLACE FUNCTION count_xp_reconcile_given_up(
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_max_attempts INTEGER
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COUNT(*)::integer
    FROM (
        SELECT c.id
        FROM check_ins c
        WHERE c.created_at >= p_from
          AND c.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
        UNION ALL
        SELECT g.id
        FROM generated_recipe_check_ins g
        WHERE g.created_at >= p_from
          AND g.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM generated_recipe_xp_events e WHERE e.check_in_id = g.id)
    ) m
    JOIN xp_award_attempts a ON a.check_in_id = m.id
    WHERE a.attempts >= p_max_attempts;
$$;

CREATE OR REPLACE FUNCTION list_xp_reconcile_given_up(
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_max_attempts INTEGER,
    p_limit INTEGER
)
RETURNS TABLE (check_in_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT m.id
    FROM (
        SELECT c.id, c.created_at
        FROM check_ins c
        WHERE c.created_at >= p_from
          AND c.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
        UNION ALL
        SELECT g.id, g.created_at
        FROM generated_recipe_check_ins g
        WHERE g.created_at >= p_from
          AND g.created_at <= p_to
          AND NOT EXISTS (SELECT 1 FROM generated_recipe_xp_events e WHERE e.check_in_id = g.id)
    ) m
    JOIN xp_award_attempts a ON a.check_in_id = m.id
    WHERE a.attempts >= p_max_attempts
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT LEAST(GREATEST(p_limit, 0), 100);
$$;

-- -----------------------------------------------------------------------------
-- Record one failed award attempt. p_reason is reduced to lowercase letters
-- and underscores (a code like 'timeout' or 'http'), at most 40 characters.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_xp_award_attempt(
    p_check_in_id UUID,
    p_kind TEXT,
    p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_reason TEXT;
BEGIN
    v_reason := left(regexp_replace(COALESCE(p_reason, ''), '[^a-z_]', '', 'g'), 40);
    IF v_reason = '' THEN
        v_reason := 'unknown';
    END IF;

    INSERT INTO xp_award_attempts (check_in_id, kind, attempts, last_attempt_at, last_reason)
    VALUES (p_check_in_id, p_kind, 1, NOW(), v_reason)
    ON CONFLICT (check_in_id) DO UPDATE
    SET attempts = xp_award_attempts.attempts + 1,
        last_attempt_at = NOW(),
        last_reason = EXCLUDED.last_reason;
END;
$$;

-- -----------------------------------------------------------------------------
-- Forget attempt rows when a check-in is deleted (stands in for a foreign key
-- with ON DELETE CASCADE, see the header).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION xp_award_attempts_forget_check_in()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM xp_award_attempts WHERE check_in_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS check_ins_forget_xp_attempts ON check_ins;
CREATE TRIGGER check_ins_forget_xp_attempts
    AFTER DELETE ON check_ins
    FOR EACH ROW EXECUTE FUNCTION xp_award_attempts_forget_check_in();

DROP TRIGGER IF EXISTS generated_check_ins_forget_xp_attempts ON generated_recipe_check_ins;
CREATE TRIGGER generated_check_ins_forget_xp_attempts
    AFTER DELETE ON generated_recipe_check_ins
    FOR EACH ROW EXECUTE FUNCTION xp_award_attempts_forget_check_in();

-- -----------------------------------------------------------------------------
-- Privileges: service_role only, like award_slot_xp.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION get_xp_reconcile_candidates(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_xp_reconcile_given_up(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION count_xp_reconcile_given_up(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_xp_award_attempt(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION xp_award_attempts_forget_check_in()
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION get_xp_reconcile_candidates(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION list_xp_reconcile_given_up(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION count_xp_reconcile_given_up(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION record_xp_award_attempt(UUID, TEXT, TEXT) TO service_role;
