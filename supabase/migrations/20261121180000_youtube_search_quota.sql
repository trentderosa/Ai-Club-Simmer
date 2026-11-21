-- YouTube search quota cooldown (server-only).
--
-- The daily pause lived in the AI server process, so a restart searched
-- again and could spend the quota a second time. Each search that is about
-- to run is one row (cooldown_until is null). A quotaExceeded or
-- dailyLimitExceeded error adds a row whose cooldown_until is the next
-- midnight Pacific, and every later search waits until that instant.
--
-- The bound of 6 matches MAX_VIDEO_SEARCHES_PER_RECIPE in the AI server.
-- A cooldown more than 36 hours ahead is rejected. Search rows older than
-- 36 hours, and cooldown rows whose pause has ended, are removed on the
-- next claim or record. XP amounts and badges are not touched.
--
-- Service-role only. RLS is on with no client policies, and anon/authenticated
-- have no table or EXECUTE access. The ai-server calls claim_youtube_search
-- and record_youtube_quota_cooldown with the service role.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

CREATE TABLE IF NOT EXISTS youtube_search_quota (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL,
    cooldown_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS youtube_search_quota_cooldown_idx
    ON youtube_search_quota (cooldown_until)
    WHERE cooldown_until IS NOT NULL;

ALTER TABLE youtube_search_quota ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

REVOKE ALL ON youtube_search_quota FROM PUBLIC, anon, authenticated;
GRANT ALL ON youtube_search_quota TO service_role;

DO $$
DECLARE
    seq text;
BEGIN
    seq := pg_get_serial_sequence('public.youtube_search_quota', 'id');
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
END
$$;

-- -----------------------------------------------------------------------------
-- Record p_count searches unless a pause is still active. Returns the pause
-- end when the caller must not call YouTube (no new search rows). Returns
-- null when the searches were recorded. p_now defaults to the database clock.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_youtube_search(
    p_count INTEGER,
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_until TIMESTAMPTZ;
BEGIN
    IF p_count IS NULL OR p_now IS NULL THEN
        RAISE EXCEPTION 'claim_youtube_search requires count and now'
            USING ERRCODE = '22023';
    END IF;
    -- Same cap as MAX_VIDEO_SEARCHES_PER_RECIPE (one recipe) and one dish search.
    IF p_count < 1 OR p_count > 6 THEN
        RAISE EXCEPTION 'claim_youtube_search count out of range'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('youtube-search-quota', 0));

    DELETE FROM youtube_search_quota
    WHERE (cooldown_until IS NOT NULL AND cooldown_until <= p_now)
       OR (cooldown_until IS NULL AND occurred_at <= p_now - INTERVAL '36 hours');

    SELECT MAX(cooldown_until) INTO v_until
    FROM youtube_search_quota
    WHERE cooldown_until IS NOT NULL
      AND cooldown_until > p_now;

    IF v_until IS NOT NULL THEN
        RETURN v_until;
    END IF;

    INSERT INTO youtube_search_quota (occurred_at)
    SELECT p_now
    FROM generate_series(1, p_count);

    RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_youtube_search(INTEGER, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_youtube_search(INTEGER, TIMESTAMPTZ)
    TO service_role;

-- -----------------------------------------------------------------------------
-- Pause every search until p_until. Returns the later of this pause and any
-- pause already stored. p_until must be after p_now and at most 36 hours ahead
-- (the YouTube quota resets at the next Pacific midnight).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_youtube_quota_cooldown(
    p_until TIMESTAMPTZ,
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_until TIMESTAMPTZ;
BEGIN
    IF p_until IS NULL OR p_now IS NULL THEN
        RAISE EXCEPTION 'record_youtube_quota_cooldown requires until and now'
            USING ERRCODE = '22023';
    END IF;
    IF p_until <= p_now OR p_until > p_now + INTERVAL '36 hours' THEN
        RAISE EXCEPTION 'record_youtube_quota_cooldown pause out of range'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('youtube-search-quota', 0));

    DELETE FROM youtube_search_quota
    WHERE (cooldown_until IS NOT NULL AND cooldown_until <= p_now)
       OR (cooldown_until IS NULL AND occurred_at <= p_now - INTERVAL '36 hours');

    INSERT INTO youtube_search_quota (occurred_at, cooldown_until)
    VALUES (p_now, p_until);

    SELECT MAX(cooldown_until) INTO v_until
    FROM youtube_search_quota
    WHERE cooldown_until IS NOT NULL
      AND cooldown_until > p_now;

    RETURN v_until;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_youtube_quota_cooldown(TIMESTAMPTZ, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_youtube_quota_cooldown(TIMESTAMPTZ, TIMESTAMPTZ)
    TO service_role;
