-- Dish recipe videos (YouTube Data API), one row per normalized dish name.
--
-- Service-role only, same pattern as technique_videos and dish_photos: the
-- ai-server writes the cache, clients never see it. videos_json is an array
-- of up to 3 videos. An empty array is a genuine "no video" miss; the server
-- retries that after a TTL. Timeouts, quota errors and other failures are
-- not written.
--
-- Do not apply this on simmer.prod from the PR; Kai applies it after merge.

CREATE TABLE IF NOT EXISTS dish_videos (
    normalized_dish_name TEXT PRIMARY KEY
        CHECK (char_length(normalized_dish_name) BETWEEN 1 AND 200),
    search_query TEXT NOT NULL,
    videos_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dish_videos_json_array CHECK (jsonb_typeof(videos_json) = 'array'),
    CONSTRAINT dish_videos_json_size CHECK (jsonb_array_length(videos_json) <= 3)
);

ALTER TABLE dish_videos ENABLE ROW LEVEL SECURITY;
-- No policies: client roles see nothing. The ai-server uses the service role.

REVOKE ALL ON dish_videos FROM PUBLIC, anon, authenticated;
GRANT ALL ON dish_videos TO service_role;
