# Simmer AI Server

Local Node/TypeScript server that proxies recipe generation and Coach's notes to Ollama,
finds technique videos on YouTube, verifies Supabase user JWTs, enforces path order, saves
check-ins, awards XP (path slots and Cook anything), and reports earned badges. Request and response shapes are in
[../docs/CLIENT_API.md](../docs/CLIENT_API.md).

## Development

```bash
cp .env.example .env   # fill in values; .env is gitignored
npm ci
npm run dev            # loads .env if present
npm run lint && npm run typecheck && npm test
```

`npm run dev`, `npm start`, and `npm run reconcile:xp` (and `reconcile:xp:dev`)
load `.env` from this directory when the file exists. Already-set environment
variables win, and a missing `.env` is a no-op, so CI and tests do not need one.

Without `SUPABASE_JWKS_URI` or `SUPABASE_JWT_SECRET`, startup fail-closes to stub
in-memory storage: auth and check-ins stay disabled, and recipes are not saved to
Supabase. Check-ins then return `xp: { status: "skipped" }`.

If recipe generation fails because Ollama is unreachable, the server log includes
the underlying cause (for example `ECONNREFUSED` and the `OLLAMA_BASE_URL` host).
The client still gets a generic `Recipe generation failed. Please try again.` error.

Every rejected generation attempt is logged as `Recipe attempt rejected` with a `reason`
(`invalid_json`, `schema_invalid` with issue paths and codes only, `ollama_error` with the error
name and message, or `mastery_too_few_hidden_steps`) and the attempt number, never model text.
A success after retries logs `Recipe generated after retries`. The recipe is cleaned after
validation (trimmed ingredients, no "Simmer:" title prefix, tidy technique names), and the photo
and dish-video lookup runs while Ollama generates. The check-in Coach's note prompt gets the
dish name and the user's equipment (one small `profiles` read, plus one dish read per new
check-in: `getPathSlot` for a path slot, or a `user_generated_recipes` read scoped by id and
user_id for Cook anything; a failed lookup is logged and the note is written without it).
A JSON parse failure is logged and returned only as `invalid_json`, because the parser's
error text quotes the model's output.

## CORS

The Expo web build is a browser, so the server sends CORS headers only for
origins in `ALLOWED_ORIGINS` (comma-separated). When that variable is unset or
empty, the allowlist is the Expo Metro/web dev origins: `http://localhost:8081`,
`http://127.0.0.1:8081`, `http://localhost:19006`, and `http://127.0.0.1:19006`
(8081 is Expo SDK 58's default; 19006 is the classic Expo webpack web port).
Allowed requests get their `Origin` echoed back and `Vary: Origin`. Preflight
(`OPTIONS`) allows `Authorization`, `Content-Type`, and `Idempotency-Key`.
Unknown origins get no CORS headers. A wildcard (`*`) is rejected at startup.

The live GitHub Pages app is the origin `https://trentderosa.github.io` (scheme
and host only; the `/Ai-Club-Simmer` path is not part of the origin). Add that
origin to `ALLOWED_ORIGINS` so the Pages app can call this server. Setting the
variable replaces the defaults, so include any dev origins you still want.
The Pages origin is not in the default list.

## Phone-reachable demo

A phone running the GitHub Pages app cannot call `127.0.0.1` on the laptop. Run a tunnel on that laptop. It connects to the server on loopback and gives the phone an https URL. Put real values only in `ai-server/.env`. Copy the example only when that file is not already there, so you do not replace keys that are already filled in:

```bash
cd ai-server
[ -f .env ] || cp .env.example .env
npm ci
npm run build
NODE_ENV=production HOST=127.0.0.1 TRUST_PROXY=true npm start
```

`npm start` loads `.env`. Do not put `SUPABASE_SERVICE_ROLE_KEY`, or any other secret, on the command line. Shell variables that are already set win over `.env`. `SUPABASE_JWT_SECRET` can stand in for `SUPABASE_JWKS_URI` on an HS256 project. This project's tokens are ES256, so use the JWKS URL.

| Variable | In `.env` |
| --- | --- |
| `SUPABASE_URL` | Project URL. Required when `NODE_ENV=production`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. Server only. Required in production. Never on the command line. |
| `SUPABASE_JWKS_URI` or `SUPABASE_JWT_SECRET` | One of these. Required in production. Prefer the JWKS URL. |
| `OLLAMA_BASE_URL` | Default `http://localhost:11434`. |
| `OLLAMA_MODEL` | Default `llama3.2`. Must match a pulled model. |
| `HOST` | `127.0.0.1` for the https tunnel (the command above). Same-Wi-Fi (`0.0.0.0`) is for the Expo dev client only, with no tunnel. The GitHub Pages app needs the https tunnel, because an https page cannot call an http LAN address. |
| `TRUST_PROXY` | Exactly `true` for the tunnel. Express then trusts `X-Forwarded-For` only when the direct peer is loopback. A LAN client cannot spoof `req.ip`, so `HOST=0.0.0.0` is safe with this setting. |
| `ALLOWED_ORIGINS` | Include `https://trentderosa.github.io` (scheme and host only; `/Ai-Club-Simmer` is not part of the origin). Setting `ALLOWED_ORIGINS` replaces the localhost defaults, so list any dev origins you still want. The Pages origin is not in the default list. |
| `PORT` | Default `3001`. |

Point the tunnel at loopback, for example `cloudflared tunnel --url http://127.0.0.1:3001` or `ngrok http 127.0.0.1:3001`, and set the app's `EXPO_PUBLIC_AI_SERVER_URL` to that https URL. Auth is unchanged: production still requires the Supabase settings above, stub auth stays off, and the unauthenticated preview route stays off.

Cook anything's persistent per-user limit needs migration `20261120150000_cook_anything_generation_limits.sql` already applied by a person. This server does not apply migrations. Do not apply that file from here. Until it is applied, an uncached Cook anything generation fails closed (`503`, `GENERATION_RATE_LIMIT_UNAVAILABLE`) and does not call Ollama. Saved dishes still load. Timeouts, caches, and rate limits stay as they are, including the default 5 uncached generations per hour, the per-IP request limits, and the Ollama, YouTube, dish-photo, and XP timeouts.

`curl http://127.0.0.1:3001/health` should return `{"status":"ok",...}`. The startup log should show `Check-in route: ENABLED`.

## Production config

Set these in the server's environment (never in the repo, chat, or logs):

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. Server-side only. Used to save check-ins and call `award_slot_xp` / `award_generated_recipe_xp` |
| `SUPABASE_JWKS_URI` | JWKS URL for this project's ES256 access tokens: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. Without this or `SUPABASE_JWT_SECRET`, startup fail-closes to stub storage. |
| `SUPABASE_JWT_SECRET` | Optional HS256 secret. Prefer `SUPABASE_JWKS_URI` — this project's tokens are ES256. |
| `XP_AWARD_TIMEOUT_MS` | Optional. Timeout for each `award_slot_xp` call (default `5000` ms, range `100`–`60000`). An invalid value stops startup |
| `YOUTUBE_API_KEY` | Optional. Enables technique videos (F4). Server-side only |
| `YOUTUBE_TIMEOUT_MS` | Optional. Timeout for each YouTube search (default `5000` ms, range `100`–`60000`) |
| `DISH_PHOTO_LOOKUP_TIMEOUT_MS` | Optional. Timeout for one Wikimedia Commons dish-photo lookup (default `2500` ms, range `500`–`10000`). A timeout or failure returns `photo: null`. No API key. |
| `VIDEO_LOOKUP_BUDGET_MS` | Optional. Time budget for all of one recipe's searches together (default `8000` ms, range `100`–`60000`). An invalid value stops startup |

With `NODE_ENV=production`, the server exits at startup and names any missing variable. `TRUST_PROXY=true` trusts `X-Forwarded-For` only from a loopback peer, for both the tunnel (`HOST=127.0.0.1`) and same-Wi-Fi (`HOST=0.0.0.0`). See [Phone-reachable demo](#phone-reachable-demo).

`ENABLE_PREVIEW_ROUTE=true` mounts the unauthenticated `POST /api/recipes/generate-preview` route in development only. Production ignores that flag, leaves the route off, and logs a startup warning if the flag is set.

## Health

`GET /health` is unauthenticated and does not call Ollama, Supabase, or YouTube. It returns `{"status":"ok","timestamp":"..."}`.

`GET /health/deep` is also unauthenticated. It reports three checks in parallel. Ollama and Supabase are each limited to 2 seconds. YouTube is a local key-presence check and does not call the Data API, so it spends no quota and does not change search caching or the quota cooldown.

- **Ollama:** `GET /api/tags` on the configured host, and the configured model name is in that list (`llama3.2` matches `llama3.2:latest`).
- **Supabase:** one row from `path_slots` (`select=id&limit=1`) using the service-role key.
- **YouTube:** the API key is set. A missing or blank key is `skipped` with reason `not_configured`. The Data API is not called.

Ollama and Supabase gate the endpoint. `status` is `ok` when both are `ok` and the YouTube key is set. `status` is `degraded` when both are `ok` and YouTube is `skipped`. `status` is `fail` when Ollama or Supabase fails, including when the YouTube key is also missing, so an operator can see Ollama is down without a missing key failing an otherwise healthy check. A failing dependency includes a reason of `not_configured`, `unreachable`, `timeout`, or `model_missing`. The HTTP status is 200 when `status` is `ok` or `degraded`, and 503 when it is `fail`. The last report (ok, degraded, or fail) is cached for 5 seconds (`DEEP_HEALTH_CACHE_TTL_MS`). Concurrent requests reuse one in-flight check, so repeated hits make at most one Ollama `/api/tags` call and one Supabase `path_slots` read per window. The body never includes keys, request URLs, response bodies, or stack traces. A fresh `fail` logs `health_deep_failed` as a warning on every new check. `health_deep_degraded` is logged only when the status changes to `degraded`, so a missing YouTube key does not warn again on every cache refresh. Logs use reason codes only.

## Recipes: path order and videos

`POST /api/recipes/generate/:slotId` reads the slot and the user's onboarding profile (plus
their last 3 check-ins, for the Coach's note) from Supabase with the service role
(`src/repositories/path-repository.ts`). A saved recipe is returned immediately
(`cached: true`), masked when the slot is the mastery challenge. An unknown slot is
404 even if a saved recipe exists, so hidden steps are never returned unmasked.
Otherwise the server first calls `is_slot_unlocked` and answers `403 SLOT_LOCKED`
for a locked slot.

With `YOUTUBE_API_KEY` set, `src/services/video-finder.ts` runs one YouTube search per
distinct technique in a new recipe and caches it in `technique_videos`. The search looks at
up to 5 results and, when a title shares the technique's words, one `videos.list` call for
duration. It keeps the first hit that names the technique. A clip under 60 seconds, or a
title marked Shorts, is kept only when it reads as a technique demo, and a title that names
a different dish is dropped. If every hit is rejected, that technique is cached as "no
result" and the recipe still returns with no video for the step. Misses are cached for
7 days and a recipe makes at most 6 new searches. The searches run concurrently under one
time budget (`VIDEO_LOOKUP_BUDGET_MS`, default 8000 ms); a search that finishes after the
budget still writes the shared cache. A cached video's title is checked again on read, with
no YouTube call: one that no longer names the technique or names a different dish counts as
a miss and is searched again (a cached video with no title is kept). The response has
`videos[techniqueName]`. Safe search,
the embeddable filter, the watch-URL allowlist, the timeout, and the quota cooldown are unchanged.

The same key is used by `src/services/dish-video-finder.ts` for one "{dish} recipe" search
per normalized dish name (path slots and Cook anything). A follow-up `videos.list` call
keeps embeddable videos about 3–20 minutes long whose titles name that dish and not a
different one ("fried chicken and rice" is not fried rice), and returns at most 3, highest
view count first, as `dish_videos`. Title matching uses the tightest window of the dish's
words, so "Rice cooker hack: Chicken Fried Rice" names fried rice. Only cooking
verbs take -ed or -ing, so "Roasted Chicken" names roast chicken and "Rolled Egg
Omelette" does not name egg roll. A rejected search is an
empty list. Results are cached in `dish_videos` (migration `20261117201646_dish_videos.sql`).
Cached titles are checked again on read, with no YouTube call. Off-target videos are dropped,
and when none survive the dish is searched again and the new result replaces the cache row. An empty result is
retried after 7 days. Quota and network failures are not cached; a failed search uses a
short per-dish cooldown, and a quota exhaustion pauses every dish search until midnight
Pacific. `dish_videos` is `[]`, and the recipe still returns. Errors never include the
request URL or the key.

Results are stored in `user_recipes.video_ids` (Cook anything uses
`user_generated_recipes.video_ids`) only when the lookup is complete, meaning every
technique got a video or a genuine "no result". If any search failed, timed out, ran past the
budget or was skipped by the cap, nothing is stored and the lookup runs again the next time
the recipe loads. A saved map is checked on the next read. A titled video that does not name
its technique is looked up again, still under the 6-search cap, and the column is replaced
only when that lookup finishes. A saved video with no title is kept. The column is not cleared. Video problems never fail the recipe. They are logged as
`video_search_failed`, `video_lookup_budget_exceeded`, `recipe_videos_incomplete`,
`recipe_videos_save_failed` or `recipe_videos_failed`. The `video_ids` update aborts after
5000 ms.

If a profile can't be used for generation, the server logs `user_profile_invalid` with the
failing field paths only (no values). Equipment is cleaned first (trimmed, empty and duplicate
items dropped, items cut to 100 chars, at most 50 items), so messy equipment never blocks a user.

## Mastery challenge (slot 10)

The final slot's recipe is always returned masked (`src/mastery/mask.ts`): every non-safety
step gets placeholder text and `isHidden: true`. The safety flagger keeps raw-protein rinse,
pat-dry, and poultry doneness steps visible. The saved recipe is unchanged. Hidden step
text comes only from `src/routes/mastery.ts` (mounted when Supabase and a JWT verifier are
configured; the startup log shows `Mastery route: ENABLED`):

- `POST /api/mastery/sessions` `{ slot_id }` starts the user's session, or resumes the open
  one (`start_mastery_session`).
- `POST /api/mastery/sessions/:id/reveal` `{ step_index }` records the reveal and returns the
  step (`reveal_mastery_step`).

Both are per-user rate limited (60/min by default). The check-in sends `mastery_session_id`,
and the database copies the reveal counts from that session. A session backs one check-in;
reusing it returns `409 MASTERY_SESSION_USED`. See `docs/CLIENT_API.md` for the contract.


## Cook anything

`POST /api/recipes/cook-anything` accepts `{ "dish": "..." }`. The dish is trimmed and
capped (`COOK_ANYTHING_MAX_DISH_LENGTH`, default 80), and empty, junk, or injection-like
input is rejected (`400 INVALID_DISH`). The name is normalized (lowercase, trimmed,
collapsed whitespace, punctuation stripped). A saved row in `user_generated_recipes` for
that user and normalized name is returned as `cached: true` and does not count against the
per-user generation rate limit (`COOK_ANYTHING_RATE_LIMIT_*`, default 5 uncached
generations per hour). Otherwise the server generates through the existing Ollama recipe
path, applies the same food-safety prompt rule (no rinsing raw poultry or meat), the same safety flagger (an affirmative raw-protein rinse is retried, and if every attempt still rinses that step stays flagged and visible, as do pat-dry and poultry doneness steps), and the same recipe cleanup as path recipes, looks up videos the same way as a path slot, looks up a Wikimedia Commons dish photo (`src/services/dish-photo.ts`; CC0 / public domain / CC BY / CC BY-SA only; a found photo is cached in `dish_photos` and stored as `photo_json`; a genuine miss is cached for 7 days) and dish videos (`dish_videos`), clamps the XP *counts* (not the
saved recipe body) to `FREEFORM_COUNT_BOUNDS` (1–10 / 1–12 / 1–45), and stores the
frozen `xp_value`. A later save of the same dish cannot raise those counts. A fully
clamped recipe has `xp_value` 177, below roast chicken (181). The daily cap
(default 200) still applies when today's slot + free-form XP would exceed it.

The per-user generation count is stored in `cook_anything_generation_hits`
(migration `20261120150000_cook_anything_generation_limits.sql`, applied after merge).
A restart or a second process sees the same window. Each allowed uncached generation
is one row; a hit exactly one window old no longer counts, and that user's expired
rows are removed on the next attempt. The table is service-role only (RLS on, no
client policies). The server calls `try_cook_anything_generation` and aborts it after
the usual Supabase REST timeout. If that call fails, the route returns `503` and does
not generate, so a database miss cannot open unlimited Ollama calls. Cached dishes
skip the limiter. Without `SUPABASE_URL` and the service-role key (dev only;
production refuses to start that way), or when stub auth is on, the limiter stays in
memory and still resets on restart. The limits themselves are unchanged (default 5
uncached generations per hour).

`POST /api/check-ins` with `generated_recipe_id` awards XP via `award_generated_recipe_xp`
(service role only). It uses the same slot formula, 50% repeats keyed on the normalized
dish name, the shared 100 XP/week repeat cap, and a daily cap (`freeform_daily_cap`,
default 200) that counts today's slot XP and free-form XP together. A failed award leaves
the check-in saved; `npm run reconcile:xp` retries it the same way as a path slot.

## XP on check-in

`POST /api/check-ins` saves the check-in, then calls `award_slot_xp(check_in_id)` over
PostgREST with the service-role key (`src/services/xp-awarder.ts`). The client never calls
`award_slot_xp`; since migration `20261112220000_lock_rpc_execute_grants.sql` only
`service_role` can execute it. The database applies the formula, the 50% repeat rule, the
100 XP/week repeat cap and `UNIQUE(check_in_id)`.

The call is aborted after `XP_AWARD_TIMEOUT_MS` (default 5000 ms).

If the award fails, the check-in stays saved, the server logs `xp_award_failed` with the
`check_in_id`, `slot_id` and a `reason` (`timeout`, `http`, `network`, `already_awarded`,
`invalid_response`, or `unknown`; no secrets), and the response carries `xp: { status: "failed" }`.
A timeout doesn't prove the award didn't happen: the database may have committed it after the
server stopped waiting. The reconcile job handles both cases.

## Reconcile missing XP awards

`src/jobs/reconcile-xp.ts` retries awards for path check-ins that have no `xp_events` row
and Cook anything check-ins that have no `generated_recipe_xp_events` row.

```bash
npm run build
npm run reconcile:xp -- --dry-run   # list candidates only
npm run reconcile:xp                # award them
npm run reconcile:xp:dev            # same, via tsx without building
```

It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The npm scripts load `.env` when
that file exists; already-set environment variables still win. Optional settings:

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `XP_RECONCILE_INTERVAL_MS` | `600000` | `0` (off), `60000`–`86400000` | In-server schedule only: time between runs |
| `XP_RECONCILE_LOOKBACK_HOURS` | `168` | `1`–`720` | Only check-ins created in this many past hours |
| `XP_RECONCILE_MIN_AGE_SECONDS` | `120` | `0`–`86400` | Skip newer check-ins whose live award may still be running |
| `XP_RECONCILE_BATCH_LIMIT` | `100` | `1`–`1000` | Most check-ins per run (`batch_full: true` in the summary means run again) |
| `XP_RECONCILE_MAX_ATTEMPTS` | `15` | `1`–`100` | Failed attempts per check-in before it is given up on |
| `XP_RECONCILE_RETRY_BASE_MINUTES` | `10` | `1`–`1440` | Retry backoff base: n failures wait base × 2^(n-1) minutes, max 24 h |
| `XP_AWARD_TIMEOUT_MS` | `5000` | `100`–`60000` | Timeout for the scan and for each award call |

The lookback, minimum age, batch limit and timeout settings also apply to the in-server
schedule. An out-of-range value stops the server from starting when the schedule is on.

How it works:

1. One PostgREST RPC, with the service role: `get_xp_reconcile_candidates(p_from, p_to,
   p_limit, p_max_attempts, p_retry_base_minutes)` (migration `20261118120000_xp_award_attempts.sql`, applied after
   merge). It returns check-ins in the window with no `xp_events` row (path) or no
   `generated_recipe_xp_events` row (Cook anything), joined to the server-only
   `xp_award_attempts` table. Order: never attempted first, then oldest last attempt, then
   oldest check-in, at most the batch limit. Check-ins with `attempts >= XP_RECONCILE_MAX_ATTEMPTS`
   are left out, so 100+ check-ins that keep failing can't starve newer ones. A check-in with n failed
   attempts is also skipped until `last_attempt_at` + base × 2^(n-1) minutes (base is
   `XP_RECONCILE_RETRY_BASE_MINUTES`, max 24 h). With the defaults the gaps are 10, 20, 40, 80, 160,
   320, 640, 1280, then 1440 minutes, so the 15 attempts are spread over about 7.8 days (past the
   168-hour lookback) and a short outage can't use them up. It reads only ids,
   slot ids and timestamps. The job then processes the chosen batch oldest first, so first-vs-repeat
   follows check-in order inside a batch. (A newer check-in can now be awarded before an older one
   that keeps failing.)
2. For each one, oldest first, it calls `award_slot_xp(check_in_id)` or
   `award_generated_recipe_xp(check_in_id)`. The database still applies the formula, the
   50% repeat rule, the 100 XP/week repeat cap and, for Cook anything, the daily cap.
3. If a check-in got its award in the meantime (another run, or a late live award),
   `UNIQUE(check_in_id)` on that XP table rejects the second one (Postgres `23505`, HTTP 409).
   The job counts it as `skipped`, not failed. So repeated or concurrent runs never double-award.
4. Every failed award calls `record_xp_award_attempt(check_in_id, kind, reason)`, which adds
   one to that check-in's attempts and stores a short reason code (`timeout`, `http`,
   `network`, `invalid_response`, `not_configured`, `unknown`). A success or an already-awarded
   check-in needs no row. After the run it logs `xp_reconcile_given_up` with the count of
   in-window check-ins that hit the max attempts and up to 20 of their `check_in_ids` (ids only).
5. It logs `xp_reconcile_awarded` / `xp_reconcile_award_failed` per check-in and one
   `xp_reconcile_summary` line with `scanned`, `awarded`, `skipped`, `failed` and `given_up`.

If the migration isn't applied yet, the scan fails with `xp_award_attempts migration not applied (20261118120000)`.

To retry a given-up check-in, reset its attempts (safe: awards are idempotent, `UNIQUE(check_in_id)`
rejects a second one):

```sql
DELETE FROM xp_award_attempts WHERE check_in_id = '<id from the log>';
-- or everything:
DELETE FROM xp_award_attempts;
```

The functions and the table are service-role only (RLS on, no client policies; anon and
authenticated have no access). `check_in_id` has no foreign key because it points at one of two
tables; delete triggers on both check-in tables remove the attempt row instead.

Exit code `0` means no failures, `1` means an award or the scan failed, and `2` means bad config or arguments.
The server also runs this job on a timer (`src/jobs/reconcile-scheduler.ts`). It is on when
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, stub auth is off and
`XP_RECONCILE_INTERVAL_MS` is not `0`. The first run is one interval after start, runs never
overlap (a busy tick is skipped and logs `xp_reconcile_skipped_overlap`), and errors are logged
without stopping later runs. When a run's batch was full and made progress (something awarded or already awarded), it schedules one follow-up run 5 seconds
later (not overlapping, timer unref'd) instead of waiting the whole interval, at most 3 follow-ups
in a row; the next regular tick starts fresh. It logs `xp_reconcile_summary` only when it scanned or failed
something. The CLI stays available for dry runs and one-off retries.

The weekly cap is computed for the week the award runs (UTC), so a repeat retried in a later
week counts toward that week's cap (PRD open question 10).
