-- Cook-anything generation rate limit (server-only).
--
-- Uncached generations were counted in process memory, so a restart or a
-- second process forgot them. Each allowed generation is one row. The same
-- per-user window (default 5 per hour; bounds match COOK_ANYTHING_RATE_LIMIT)
-- applies after a restart. Cached dishes are not recorded here.
--
-- A hit at exactly (now - window) is outside the window, matching the
-- in-memory limiter (occurred_at > cutoff). Expired rows for that user are
-- removed on their next attempt. XP amounts, the daily cap, and badges are
-- not touched.
--
-- Service-role only. RLS is on with no client policies, and anon/authenticated
-- have no table or EXECUTE access. The ai-server calls
-- try_cook_anything_generation with the service role.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

CREATE TABLE IF NOT EXISTS cook_anything_generation_hits (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS cook_anything_generation_hits_user_occurred_idx
    ON cook_anything_generation_hits (user_id, occurred_at);

ALTER TABLE cook_anything_generation_hits ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

REVOKE ALL ON cook_anything_generation_hits FROM PUBLIC, anon, authenticated;
GRANT ALL ON cook_anything_generation_hits TO service_role;

DO $$
DECLARE
    seq text;
BEGIN
    seq := pg_get_serial_sequence('public.cook_anything_generation_hits', 'id');
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
END
$$;

-- -----------------------------------------------------------------------------
-- Consume one generation if this user is under the cap. Returns false when
-- the window is full (no new row). p_now defaults to the database clock so
-- processes with skewed clocks share one window.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION try_cook_anything_generation(
    p_user_id UUID,
    p_window_ms INTEGER,
    p_max INTEGER,
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cutoff TIMESTAMPTZ;
    v_count INTEGER;
BEGIN
    IF p_user_id IS NULL OR p_window_ms IS NULL OR p_max IS NULL OR p_now IS NULL THEN
        RAISE EXCEPTION 'try_cook_anything_generation requires user, window, max, and now'
            USING ERRCODE = '22023';
    END IF;
    -- Same bounds as COOK_ANYTHING_RATE_LIMIT in ai-server (1s–24h, 1–100).
    IF p_window_ms < 1 OR p_window_ms > 86400000 OR p_max < 1 OR p_max > 100 THEN
        RAISE EXCEPTION 'try_cook_anything_generation window or max out of range'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('cook-anything-gen:' || p_user_id::text, 0));

    v_cutoff := p_now - (p_window_ms * INTERVAL '1 millisecond');

    DELETE FROM cook_anything_generation_hits
    WHERE user_id = p_user_id
      AND occurred_at <= v_cutoff;

    SELECT COUNT(*)::integer INTO v_count
    FROM cook_anything_generation_hits
    WHERE user_id = p_user_id
      AND occurred_at > v_cutoff;

    IF v_count >= p_max THEN
        RETURN FALSE;
    END IF;

    INSERT INTO cook_anything_generation_hits (user_id, occurred_at)
    VALUES (p_user_id, p_now);

    RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION try_cook_anything_generation(UUID, INTEGER, INTEGER, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION try_cook_anything_generation(UUID, INTEGER, INTEGER, TIMESTAMPTZ)
    TO service_role;
