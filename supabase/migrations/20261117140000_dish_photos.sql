-- Cook anything dish photo cache (Wikimedia Commons) and a photo_json column
-- on user_generated_recipes so the app can reload a saved recipe's hero photo.
--
-- The cache is service-role only, like technique_videos: the ai-server writes
-- it, clients never see it. image_url NULL caches a genuine "no photo found"
-- miss; the server reapplies a TTL and does not cache timeouts or errors.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

-- -----------------------------------------------------------------------------
-- 1. Shared cache, keyed by the same normalized dish name as free-form recipes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dish_photos (
    normalized_dish_name TEXT PRIMARY KEY
        CHECK (char_length(normalized_dish_name) BETWEEN 1 AND 200),
    image_url TEXT,
    author TEXT,
    license TEXT,
    license_url TEXT,
    source_url TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dish_photos_photo_shape CHECK (
        (
            image_url IS NULL
            AND author IS NULL
            AND license IS NULL
            AND license_url IS NULL
            AND source_url IS NULL
        )
        OR (
            image_url IS NOT NULL
            AND author IS NOT NULL
            AND license IS NOT NULL
            AND license_url IS NOT NULL
            AND source_url IS NOT NULL
        )
    )
);

ALTER TABLE dish_photos ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

REVOKE ALL ON dish_photos FROM PUBLIC, anon, authenticated;
GRANT ALL ON dish_photos TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Persist the found photo on the owner's recipe row (client SELECT, same
--    as video_ids). NULL means none stored yet; a later lookup may fill it.
--    The existing freeze trigger already leaves non-XP columns writable.
-- -----------------------------------------------------------------------------
ALTER TABLE user_generated_recipes
    ADD COLUMN IF NOT EXISTS photo_json JSONB;
