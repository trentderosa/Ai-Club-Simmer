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

## CORS

The Expo web build is a browser, so the server sends CORS headers only for
origins in `ALLOWED_ORIGINS` (comma-separated). When that variable is unset or
empty, the allowlist is the Expo Metro/web dev origins: `http://localhost:8081`,
`http://127.0.0.1:8081`, `http://localhost:19006`, and `http://127.0.0.1:19006`
(8081 is Expo SDK 58's default; 19006 is the classic Expo webpack web port).
Allowed requests get their `Origin` echoed back and `Vary: Origin`. Preflight
(`OPTIONS`) allows `Authorization`, `Content-Type`, and `Idempotency-Key`.
Unknown origins get no CORS headers. A wildcard (`*`) is rejected at startup.

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

With `NODE_ENV=production`, the server exits at startup and names any missing variable.

`ENABLE_PREVIEW_ROUTE=true` mounts the unauthenticated `POST /api/recipes/generate-preview` route in development only. Production ignores that flag, leaves the route off, and logs a startup warning if the flag is set.

## Health

`GET /health` is unauthenticated and does not call Ollama, Supabase, or YouTube. It returns `{"status":"ok","timestamp":"..."}`.

`GET /health/deep` is also unauthenticated. It reports `ok` or `fail` for three checks, in parallel, each limited to 2 seconds:

- **Ollama:** `GET /api/tags` on the configured host, and the configured model name is in that list (`llama3.2` matches `llama3.2:latest`).
- **Supabase:** one row from `path_slots` (`select=id&limit=1`) using the service-role key.
- **YouTube:** the API key is set. The Data API is not called, so this does not spend quota.

`status` is `ok` only when all three are `ok`. A failure includes a reason of `not_configured`, `unreachable`, `timeout`, or `model_missing`. The HTTP status is 200 when `status` is `ok` and 503 when it is `fail`; the body shape is unchanged. The last report (ok or fail) is cached for 5 seconds (`DEEP_HEALTH_CACHE_TTL_MS`). Concurrent requests reuse one in-flight check, so repeated hits make at most one Ollama `/api/tags` call and one Supabase `path_slots` read per window. The body never includes keys, request URLs, response bodies, or stack traces. A missing YouTube key is `not_configured`, which makes the overall status `fail` even when Ollama and Supabase are up.

## Recipes: path order and videos

`POST /api/recipes/generate/:slotId` reads the slot and the user's onboarding profile (plus
their last 3 check-ins, for the Coach's note) from Supabase with the service role
(`src/repositories/path-repository.ts`). A saved recipe is returned immediately
(`cached: true`), masked when the slot is the mastery challenge. An unknown slot is
404 even if a saved recipe exists, so hidden steps are never returned unmasked.
Otherwise the server first calls `is_slot_unlocked` and answers `403 SLOT_LOCKED`
for a locked slot.

With `YOUTUBE_API_KEY` set, `src/services/video-finder.ts` runs one YouTube search per
distinct technique in a new recipe and caches it in `technique_videos`. It caches misses for
7 days and makes at most 6 new searches per recipe. The searches run concurrently under one
time budget (`VIDEO_LOOKUP_BUDGET_MS`, default 8000 ms); a search that finishes after the
budget still writes the shared cache. The response has `videos[techniqueName]`.

Results are stored in `user_recipes.video_ids` only when the lookup is complete, meaning every
technique got a video or a genuine "no result". If any search failed, timed out, ran past the
budget or was skipped by the cap, nothing is stored and the lookup runs again the next time
the recipe loads. Video problems never fail the recipe. They are logged as
`video_search_failed`, `video_lookup_budget_exceeded`, `recipe_videos_incomplete`,
`recipe_videos_save_failed` or `recipe_videos_failed`. The `video_ids` update aborts after
5000 ms.

If a profile can't be used for generation, the server logs `user_profile_invalid` with the
failing field paths only (no values). Equipment is cleaned first (trimmed, empty and duplicate
items dropped, items cut to 100 chars, at most 50 items), so messy equipment never blocks a user.

## Mastery challenge (slot 10)

The final slot's recipe is always returned masked (`src/mastery/mask.ts`): every non-safety
step gets placeholder text and `isHidden: true`. The saved recipe is unchanged. Hidden step
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
path, looks up videos the same way as a path slot, looks up a Wikimedia Commons dish photo (`src/services/dish-photo.ts`; CC0 / public domain / CC BY / CC BY-SA only; cached in `dish_photos` and stored as `photo_json` when found), clamps the XP *counts* (not the
saved recipe body) to `FREEFORM_COUNT_BOUNDS` (1–10 / 1–12 / 1–45), and stores the
frozen `xp_value`. A later save of the same dish cannot raise those counts. A fully
clamped recipe has `xp_value` 177, below roast chicken (181). The daily cap
(default 200) still applies when today's slot + free-form XP would exceed it.

The per-user generation limiter is in-memory per process: it resets on restart, is not
shared across instances, and does not prune old user keys. That is enough for the demo.

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
| `XP_RECONCILE_LOOKBACK_HOURS` | `168` | `1`–`720` | Only check-ins created in this many past hours |
| `XP_RECONCILE_MIN_AGE_SECONDS` | `120` | `0`–`86400` | Skip newer check-ins whose live award may still be running |
| `XP_RECONCILE_BATCH_LIMIT` | `100` | `1`–`1000` | Most check-ins per run (`batch_full: true` in the summary means run again) |
| `XP_AWARD_TIMEOUT_MS` | `5000` | `100`–`60000` | Timeout for the scan and for each award call |

How it works:

1. Two PostgREST reads, with the service role, in the window, each oldest first and capped
   at the batch limit. One is `check_ins` with no matching `xp_events` row
   (`select=id,slot_id,created_at,xp_events(id)&xp_events=is.null`). The other is
   `generated_recipe_check_ins` with no matching `generated_recipe_xp_events` row
   (`select=id,created_at,generated_recipe_xp_events(id)&generated_recipe_xp_events=is.null`).
   The job merges them oldest first and keeps at most the batch limit. It reads only ids,
   slot ids and timestamps. No migration was needed.
2. For each one, in that order, it calls `award_slot_xp(check_in_id)` or
   `award_generated_recipe_xp(check_in_id)`. The database still applies the formula, the
   50% repeat rule, the 100 XP/week repeat cap and, for Cook anything, the daily cap.
3. If a check-in got its award in the meantime (another run, or a late live award),
   `UNIQUE(check_in_id)` on that XP table rejects the second one (Postgres `23505`, HTTP 409).
   The job counts it as `skipped`, not failed. So repeated or concurrent runs never double-award.
4. It logs `xp_reconcile_awarded` / `xp_reconcile_award_failed` per check-in and one
   `xp_reconcile_summary` line with `scanned`, `awarded`, `skipped` and `failed`.

Exit code `0` means no failures, `1` means an award or the scan failed, and `2` means bad config or arguments.
Nothing schedules this job yet; run it by hand, or later from cron or a scheduler.

The weekly cap is computed for the week the award runs (UTC), so a repeat retried in a later
week counts toward that week's cap (PRD open question 10).
