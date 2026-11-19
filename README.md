# Simmer

Simmer is the JMU AI Club "Duolingo of cooking" app for new cooks. The MVP is a single fixed path, **"Weeknight basics"**: 10 weeknight dishes in a set order, each teaching a technique, with check-ins, XP, and AI-tailored tips after each cook. Users can also type a dish outside the path ("Cook anything") and get a generated recipe, then cook and check in the same way. Free-form XP uses the same slot formula; the mock canned recipe is 84 XP. A fully clamped recipe has `xp_value` 177, below roast chicken (181). The daily cap on free-form awards remains 200.

This repo holds the product requirements, the Expo app, the AI server, and the database migrations and tests.

See [PRD.md](PRD.md) for the full MVP requirements, [docs/CLIENT_API.md](docs/CLIENT_API.md) for what the app calls on each screen, and [docs/DEMO_SETUP.md](docs/DEMO_SETUP.md) for standing up the demo. Every PR that changes behavior updates `PRD.md` and `README.md` in the same PR.

## Repo layout

```
.
├── PRD.md                 # Product requirements (MVP)
├── README.md
├── app/                   # Expo + TypeScript client (Expo Router), UI Direction A
├── ai-server/             # Express AI server (local Ollama recipes, videos, check-ins)
├── docs/                  # Client API contract, demo runbook, AI reviews
├── supabase/migrations/   # Postgres / Supabase schema and XP logic
├── tests/                 # Database tests for the schema and XP awards
└── .github/workflows/     # App CI, AI Server CI and Database Tests
```

## App

The Expo client covers the core loop plus the recipe book, profile, and Cook anything: sign up or sign in, onboarding, Today (the plan), recipe, cook mode (including the slot 10 mastery challenge, where non-safety steps start hidden, the server tracks every reveal, and the mastery badge needs zero reveals), check-in, session complete, the recipe book and the profile (XP, badges, editable onboarding answers, sign-out), and typing a dish from Today. A small bottom bar switches between Today, the recipe book and You. Requires Node.js 22.13 or later (Expo SDK 58 needs it). Mock mode runs it with fake data and no backend. Mock check-ins celebrate the same badge catalog as the database: completion seals for slots 1–9 only, and the mastery seal only when the final cook reveals nothing. A missing catalog code fails the mock check-in instead of skipping the seal, and mastery is recorded as earned only after that lookup succeeds.

```bash
cd app
npm ci
npm run web:mock       # or: npm run start:mock for Expo Go / a simulator
npm run check          # typecheck, lint, service-role guard, tests
```

To use the real backend, copy `app/.env.example` to `app/.env.local` and fill in the `EXPO_PUBLIC_*` values below. The app only ever uses the Supabase anon key. See [app/README.md](app/README.md) for the structure, how each screen maps to the API, and known gaps.

### Web build on GitHub Pages

The web build of the app is published to `https://trentderosa.github.io/Ai-Club-Simmer/` by `.github/workflows/web-deploy.yml`. It runs on every push to `main` that touches `app/**`, and by hand from the Actions tab. It runs `npm run check`, exports the site with `npm run export:web:pages`, scans `dist/` for service-role keys (`npm run check:secrets:dist`), and deploys it. The Pages build sets `EXPO_BASE_URL=/<repo name>`, which `app/app.config.ts` turns into the Expo web `baseUrl`. Local `npm run web` and the root export are unchanged. The export also copies `index.html` to `404.html` so a refresh on a deep link loads the app.

By default it publishes a mock-mode build (fake data, no backend). One-time setup:
1. Settings, Pages, Source: **GitHub Actions**.
2. To go live later, add these repository **variables** (Settings, Secrets and variables, Actions, Variables). They are public, so only the anon key goes in: `EXPO_PUBLIC_MOCK_MODE` (`0`), `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_AI_SERVER_URL`. If mock mode is off and one is missing, the build fails.
3. Before switching mock mode off, add `https://trentderosa.github.io` to `ALLOWED_ORIGINS` on the AI server and add the Pages URL to the allowed redirect URLs in Supabase auth.

The Pages site is public, and so is everything in the built app.

## AI server

Requires Node.js 18 or later (CI uses 20). For live recipe generation, a local [Ollama](https://ollama.com) instance should be running.

```bash
cd ai-server
cp .env.example .env   # fill in placeholders; never commit real keys
npm ci
npm run dev            # tsx watch, default http://127.0.0.1:3001; loads .env if present
```

`npm run dev`, `npm start`, and `npm run reconcile:xp` (and `reconcile:xp:dev`) load `ai-server/.env` when that file exists. Already-set environment variables win, and a missing `.env` is fine — CI and tests do not need one. To run the compiled server: `npm run build && npm start`. If Ollama is down, the server log includes the cause (for example `ECONNREFUSED` and the `OLLAMA_BASE_URL` host); the client still gets a generic generation error.

`GET /health` stays a fast, unauthenticated process check and returns `{"status":"ok"}`. `GET /health/deep` is also unauthenticated. It checks that the configured Ollama model is listed, that a one-row `path_slots` read with the service role succeeds, and that `YOUTUBE_API_KEY` is set. It does not call the YouTube API. Each check times out after 2 seconds. The last report (ok or fail) is reused for 5 seconds, and concurrent requests share one in-flight check. The HTTP status is 200 when every check is ok and 503 when any check fails. The JSON is only `ok` or `fail` plus a short reason code: no keys, URLs, or error text.

```bash
npm test               # vitest
npm run lint
npm run typecheck
```

## Database tests

These tests apply every file in `supabase/migrations/` against a local Postgres 15 database. They expect a `simmer_test` database, the `pgcrypto` extension, the `authenticated`, `anon`, and `service_role` roles, and a minimal `auth` schema (`auth.users`, `auth.uid()`, `auth.role()`). The exact bootstrap SQL is in [`.github/workflows/db-tests.yml`](.github/workflows/db-tests.yml).

```bash
cd tests
npm ci
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/simmer_test npm test
```

`DATABASE_URL` is for the database tests only (not in `ai-server/.env`) and defaults to that value if unset. Lint and typecheck: `npm run lint` and `npm run typecheck`.

## Real-account tests (local)

`tests/e2e/` is an end-to-end suite that signs up real (throwaway) users against a real local Supabase and the real AI server with real Ollama generation. It checks the app flow (sign-up, onboarding, plan, recipe generation, check-ins, XP, badges, mastery, Cook anything, XP retry) and that RLS and the privileged functions hold. It is not part of `npm test` and does not run in CI. Users are `e2e-<run id>-<random>@simmer.invalid` and are deleted at the end. It only runs against `127.0.0.1` or `localhost`.

Local Supabase runs Postgres 17 (like production); the CI database tests use Postgres 15. Needs Docker, Node 20+, and Ollama with the model from `ai-server/.env` pulled.

```bash
# 1. Local Supabase (applies supabase/migrations). Email confirmations are off locally.
#    Create local ES256 JWT signing keys once, like the hosted project's tokens.
#    supabase/config.toml points at supabase/signing_keys.json (gitignored, never commit it).
#    The file must exist first, then the CLI fills it in:
echo '[]' > supabase/signing_keys.json && npx supabase@3.2.0 gen signing-key --algorithm ES256
npx supabase@3.2.0 start

# 2. AI server against it. Get the values with `npx supabase@3.2.0 status -o json`
#    (API_URL, SERVICE_ROLE_KEY). Never print or commit them.
cd ai-server && npm ci && npm run build
NODE_ENV=production PORT=3001 HOST=127.0.0.1 \
  SUPABASE_URL=<API_URL> \
  SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
  SUPABASE_JWKS_URI=<API_URL>/auth/v1/.well-known/jwks.json \
  XP_RECONCILE_INTERVAL_MS=60000 XP_RECONCILE_MIN_AGE_SECONDS=30 \
  node dist/index.js

# 3. Run the suite (in another terminal, from the repo root)
cd tests && npm ci && npm run test:e2e
```

The test run reads the Supabase keys itself from `supabase status` (they are never written to disk). To use another AI server URL set `E2E_AI_URL` (default `http://127.0.0.1:3001`). A full run took about 3 to 4 minutes on an Apple-silicon laptop with `llama3.2` (real generations took 3 to 5 s each; slower machines or larger models take longer), and the XP retry test waits for scheduler ticks. The XP retry scenario (`08`) needs the in-server XP schedule from PR #30. A few setup steps seed a minimal recipe with the service role to save time; each test file says where.

For a slower, more realistic run set `E2E_REAL_GENERATION=1`: every setup recipe is a real Ollama generation instead of a seeded one. The only exception is slot 10 in scenario `05`, which stays a stored seed because that slot is locked at that point. Set `E2E_TIMING_FILE=<path>` to append one JSON line per timed step (for example each generation). Measured on an Apple-silicon Mac with `llama3.2`, YouTube off, over 3 full runs with `E2E_REAL_GENERATION=1`: all 92 tests passed each time; the runs took 8m40s, 9m22s and 9m41s; each run made 25 real generations with a median of 3.9 to 4.8 s, p90 of 5.5 to 10.1 s and max of 10.8 to 18.1 s. Scenario `06` makes about 20 generate calls in a row against the default limit of 10 per minute per IP. That works at about 4 s per generation (the e2e helper backs off on a 429), but on a faster machine set `RATE_LIMIT_MAX_REQUESTS` higher on the ai-server for real-generation runs. The server logs a `Recipe attempt rejected` warning (reason and attempt number only, never model text) for every retried generation, which explains the slow outliers.

Warning for pointing the app at local Supabase: `npm run web` in `app/` (Expo dev) loads `app/.env.local` at runtime (through `expo/virtual/env.js`) and that overrides variables set in your shell, so a dev web build can silently keep talking to the project in that file. To test the web app against local Supabase, make a static build with the dotenv loading turned off and the `EXPO_PUBLIC_*` values set in the shell, for example `EXPO_NO_DOTENV=1 EXPO_PUBLIC_SUPABASE_URL=<local API_URL> EXPO_PUBLIC_SUPABASE_ANON_KEY=<local anon key> EXPO_PUBLIC_AI_SERVER_URL=<local AI server URL> npx expo export --platform web`, then serve `dist/`. Before using it, grep the output (`dist/`) for your hosted project's reference to confirm none of it was baked in.

## Database security

Client roles (`PUBLIC`, `anon`, `authenticated`) have `EXECUTE` revoked on `public.rls_auto_enable()`. The function body is unchanged, and the revoke is guarded so it is a no-op on databases that don't have the function. Privileged functions such as `award_slot_xp`, `award_generated_recipe_xp`, `is_slot_unlocked`, `get_badges_earned_by_check_in`, `start_mastery_session` and `reveal_mastery_step` are called only from the AI server with the service role, never from the client.

The plan, badges and recipe book are derived from `check_ins` (migration `20261115000000_plan_badges_recipe_book.sql`). The recipe book also includes Cook anything dishes that have a check-in (new `get_my_recipe_book_v2()` from migration `20261118150000_recipe_book_cook_anything.sql`, applied after merge; the app falls back to the original function until then). Tapping a book entry shows the recipe read-only, the user's own check-in history and a Cook again button. The app reads them through `get_my_plan()`, `get_my_plan_summary()`, `get_my_badges()` and `get_my_recipe_book_v2()` (the original `get_my_recipe_book()` stays path-only for older builds). These take no user id and always use `auth.uid()`. Clients can't insert, update or delete check-ins (only the AI server writes them). The `technique_videos`, `dish_videos` and `dish_photos` caches are service-role only (RLS on, no client policies).

Path recipes and Cook anything recipes both return a Commons dish photo (`photo`) and up to three "Watch someone make it" videos (`dish_videos`). Technique videos stay in `videos`. The YouTube key stays on the AI server. A genuine photo miss is cached for 7 days; the only image fallback is `board.jpg`. A video search failure hides that section, does not fail the recipe, and cools down so a later open doesn't search again immediately (quota exhaustion pauses all dish searches until midnight Pacific). Today and the recipe book load photos with `POST /api/dish-photos`, which only looks up the caller's known dishes. Migration `20261117201646_dish_videos.sql` is applied after merge, the same way as `20261117140000_dish_photos.sql`.

Slot 10 recipe generation retries unless the recipe has at least 3 non-safety (hideable) steps (`MASTERY_MIN_HIDDEN_STEPS`, a mastery rule pending Ian's OK). Trivial steps (4 words or fewer, or a short serve/plate/enjoy/garnish step) stay hidden but don't count toward the 3, also pending Ian's OK, and the prompt says peeling, grating, draining, pan work and roasting are safety steps that are never hidden; saved slot 10 recipes are not regenerated. The slot 10 mastery challenge is enforced on the server (migration `20261116000000_mastery_sessions.sql`). Clients can read `user_recipes` ids but not `recipe_json`, and the `mastery_sessions` table is server-only. A hidden step's text is sent only by the reveal endpoint, which records the reveal first. A check-in's reveal counts are copied from its session, never taken from the client. Loading a saved recipe 404s if the path slot can't be looked up, so hidden steps are never returned unmasked. Deleting an account or a saved recipe that has a mastery check-in is not blocked by the immutability trigger: the follow-up migration `20261116150000_check_in_mastery_session_delete.sql` lets the foreign key clear `mastery_session_id` when the session row itself is deleted, while a direct change to the session link or the copied counts is still rejected.

## Environment variables

Copy `ai-server/.env.example` to `ai-server/.env` and fill in values locally. Placeholders only — no real keys or production URLs belong in the repo.

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` | Ollama base URL (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | Model name (default `llama3.2`) |
| `OLLAMA_MAX_TOKENS` | Max generation tokens (default `1500`) |
| `OLLAMA_TIMEOUT_MS` | Ollama timeout in ms (default `60000`) |
| `PORT` | AI server port (default `3001`) |
| `HOST` | Bind address (default `127.0.0.1`) |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the AI server (Expo web). Default: `http://localhost:8081`, `http://127.0.0.1:8081`, `http://localhost:19006`, `http://127.0.0.1:19006`. Never `*`. |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window (default `60000`) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window (default `10`) |
| `COOK_ANYTHING_MAX_DISH_LENGTH` | Max length of a Cook anything dish name (default `80`, range `10`–`200`) |
| `COOK_ANYTHING_RATE_LIMIT_WINDOW_MS` | Per-user window for uncached Cook anything generations (default `3600000`, range `1000`–`86400000`) |
| `COOK_ANYTHING_RATE_LIMIT_MAX` | Max uncached Cook anything generations per user per window (default `5`, range `1`–`100`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server only; never ship to the client) |
| `SUPABASE_JWT_SECRET` | Optional JWT secret for HS256 verification. This project's tokens are ES256, so prefer `SUPABASE_JWKS_URI`. |
| `SUPABASE_JWKS_URI` | JWKS URL for this project's ES256 access tokens, `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. Without this or `SUPABASE_JWT_SECRET`, startup fail-closes to stub in-memory storage and check-ins stay disabled. |
| `ALLOW_STUB_AUTH` | Dev only: accept any Bearer token. Forbidden when `NODE_ENV=production`. |
| `ENABLE_PREVIEW_ROUTE` | Dev only: enable the unauthenticated `/generate-preview` route. Ignored when `NODE_ENV=production`: the route stays off and startup logs a warning if this is set. |
| `TRUST_PROXY` | Set to `true` when the server sits behind a reverse proxy. Without it, all users behind the proxy share one IP for the per-IP limits (for example the 60/min cap on `POST /api/dish-photos`). |
| `NODE_ENV` | `production` enables production checks (real auth and Supabase keys required). |
| `XP_AWARD_TIMEOUT_MS` | Timeout for each `award_slot_xp` call in ms (default `5000`, range `100`–`60000`). A timeout counts as a failed award. |
| `XP_RECONCILE_INTERVAL_MS` | How often the server retries missing XP awards (default `600000` = 10 min; `0` turns it off, otherwise `60000`–`86400000`). Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; off with stub auth. |
| `XP_RECONCILE_LOOKBACK_HOURS` | Reconcile job: how far back to look for check-ins missing XP (default `168`, range `1`–`720`). |
| `XP_RECONCILE_MIN_AGE_SECONDS` | Reconcile job: skip check-ins younger than this (default `120`, range `0`–`86400`). |
| `XP_RECONCILE_BATCH_LIMIT` | Reconcile job: most check-ins handled per run (default `100`, range `1`–`1000`). When a run's batch is full and made progress, the server runs once more about 5 seconds later (at most 3 follow-ups in a row). The `XP_RECONCILE_*` limits also apply to the in-server schedule; an out-of-range value stops the server from starting when the schedule is on. |
| `XP_RECONCILE_MAX_ATTEMPTS` | Reconcile job: failed award attempts per check-in before it is given up on (default `15`, range `1`–`100`). Attempts are kept in the server-only `xp_award_attempts` table (migration `20261118120000_xp_award_attempts.sql`, applied after merge). The run logs the given-up count and up to 20 check-in ids. |
| `XP_RECONCILE_RETRY_BASE_MINUTES` | Reconcile job: retry backoff base (default `10`, range `1`–`1440`). A check-in with n failures waits base × 2^(n-1) minutes (max 24 h) before the next try: with the defaults, gaps of 10, 20, 40, 80, 160, 320, 640, 1280, then 1440 minutes, so the 15 attempts span about 7.8 days, past the 168-hour lookback. |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key for technique videos and dish videos (F4). Server only. Never an `EXPO_PUBLIC_` variable. Unset: recipes have no videos. |
| `YOUTUBE_TIMEOUT_MS` | Timeout for each YouTube search in ms (default `5000`, range `100`–`60000`). |
| `VIDEO_LOOKUP_BUDGET_MS` | Time budget in ms for all of one recipe's YouTube searches together (default `8000`, range `100`–`60000`). Past it, the recipe is returned with the videos found so far and the rest are retried on the next visit. |
| `DISH_PHOTO_LOOKUP_TIMEOUT_MS` | Timeout in ms for one Wikimedia Commons dish-photo lookup (default `2500`, range `500`–`10000`). Used for path recipes, Cook anything, and `POST /api/dish-photos` (which is rate-limited per IP before auth, 60 per minute by default, and per user after auth). A timeout or failure returns `photo: null` and never fails the recipe. No API key. |
| `EXPO_PUBLIC_SUPABASE_URL` | App: Supabase project URL. In `app/.env.local`; bundled into the app, so public values only. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | App: Supabase anon (public) key. Never the service-role key. |
| `EXPO_PUBLIC_AI_SERVER_URL` | App: AI server base URL. Prefer an HTTPS tunnel (ngrok or Cloudflare) for phones; a LAN `http://` URL with `HOST=0.0.0.0` is for local dev. |
| `EXPO_PUBLIC_MOCK_MODE` | App: leave unset or `0` for the live backend; `1` = fake data, no backend; `ai` = real Supabase, fake AI server. |
| `EXPO_PUBLIC_MOCK_XP_STATUS` | App, mock mode only: check-in XP outcome to show (`awarded`, `failed` or `skipped`). |

### Retrying failed XP awards

If a check-in's XP award fails (for example a timeout), the check-in is kept without XP. When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set and stub auth is off, the AI server retries these automatically: every 10 minutes (`XP_RECONCILE_INTERVAL_MS`) it runs the same reconcile job in-process, first run one interval after start. To run it by hand, use the CLI from `ai-server/`. It loads `ai-server/.env` when present (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`); already-set environment variables still win:

```bash
cd ai-server
npm run build
npm run reconcile:xp -- --dry-run   # list check-ins missing XP, award nothing
npm run reconcile:xp                # award path slots via award_slot_xp and Cook anything via award_generated_recipe_xp
```

Path check-ins missing an `xp_events` row and Cook anything check-ins missing a `generated_recipe_xp_events` row are both included in one batch: never-attempted first, then least recently attempted, then oldest, skipping check-ins that already failed `XP_RECONCILE_MAX_ATTEMPTS` times, so check-ins that keep failing can't starve newer ones. The batch is processed oldest first. It's safe to run repeatedly. See [ai-server/README.md](ai-server/README.md#reconcile-missing-xp-awards).
