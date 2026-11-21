-- Cook-anything generation refund (server-only).
--
-- A Cook anything request that ends busy before any model output (the queue
-- filled right after the limit check, or the first attempt's queue wait timed
-- out) did not produce a recipe, so it should not use up one of the user's generations.
-- The ai-server calls refund_cook_anything_generation to give that hit back.
-- Only busy before any model output is refunded: the server skips the refund
-- when a busy answer follows a completed model call (bad JSON, schema failure,
-- rinse rejection), so users cannot burn model time beyond the cap.
-- Validation and Ollama failures still count.
--
-- Design: refund the most recent hit for the user inside the window instead
-- of adding a try_cook_anything_generation_v2 that returns a hit id. Hits are
-- interchangeable for the sliding-window count, so deleting the newest one
-- restores exactly one unit of capacity. The newest in-window hit may belong to
-- a concurrent request of the same user rather than the one being refunded;
-- the count is the same either way. This keeps try_cook_anything_generation
-- unchanged, so the server's allow() path does not depend on this migration
-- and keeps working before it is applied. Only the refund call can fail then,
-- and the server treats that as best effort.
--
-- Idempotent: when there is no hit in the window, nothing is deleted and the
-- function returns FALSE (not an error). It deletes at most one row.
--
-- Service-role only, like try_cook_anything_generation. The table's RLS and
-- grants are unchanged.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

CREATE OR REPLACE FUNCTION refund_cook_anything_generation(
    p_user_id UUID,
    p_window_ms INTEGER,
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cutoff TIMESTAMPTZ;
    v_id BIGINT;
BEGIN
    IF p_user_id IS NULL OR p_window_ms IS NULL OR p_now IS NULL THEN
        RAISE EXCEPTION 'refund_cook_anything_generation requires user, window, and now'
            USING ERRCODE = '22023';
    END IF;
    -- Same window bounds as try_cook_anything_generation.
    IF p_window_ms < 1000 OR p_window_ms > 86400000 THEN
        RAISE EXCEPTION 'refund_cook_anything_generation window out of range'
            USING ERRCODE = '22023';
    END IF;

    -- Same per-user lock as try_cook_anything_generation, so a refund and a
    -- new charge for one user never interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('cook-anything-gen:' || p_user_id::text, 0));

    v_cutoff := p_now - (p_window_ms * INTERVAL '1 millisecond');

    SELECT id INTO v_id
    FROM cook_anything_generation_hits
    WHERE user_id = p_user_id
      AND occurred_at > v_cutoff
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;

    IF v_id IS NULL THEN
        RETURN FALSE;
    END IF;

    DELETE FROM cook_anything_generation_hits WHERE id = v_id;
    RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION refund_cook_anything_generation(UUID, INTEGER, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refund_cook_anything_generation(UUID, INTEGER, TIMESTAMPTZ)
    TO service_role;
