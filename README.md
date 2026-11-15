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

The Expo client covers the core loop plus the recipe book, profile, and Cook anything: sign up or sign in, onboarding, Today (the plan), recipe, cook mode (including the slot 10 mastery challenge, where non-safety steps start hidden and the mastery badge needs zero reveals), check-in, session complete, the recipe book and the profile (XP, badges, editable onboarding answers, sign-out), and typing a dish from Today. A small bottom bar switches between Today, the recipe book and You. Requires Node.js 22.13 or later (Expo SDK 58 needs it). Mock mode runs it with fake data and no backend:

```bash
cd app
npm ci
npm run web:mock       # or: npm run start:mock for Expo Go / a simulator
npm run check          # typecheck, lint, service-role guard, tests
```

To use the real backend, copy `app/.env.example` to `app/.env.local` and fill in the `EXPO_PUBLIC_*` values below. The app only ever uses the Supabase anon key. See [app/README.md](app/README.md) for the structure, how each screen maps to the API, and known gaps.

## AI server

Requires Node.js 18 or later (CI uses 20). For live recipe generation, a local [Ollama](https://ollama.com) instance should be running.

```bash
cd ai-server
cp .env.example .env   # fill in placeholders; never commit real keys
npm ci
npm run dev            # tsx watch, default http://127.0.0.1:3001
```

To run the compiled server: `npm run build && npm start`.

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

## Database security

Client roles (`PUBLIC`, `anon`, `authenticated`) have `EXECUTE` revoked on `public.rls_auto_enable()`. The function body is unchanged, and the revoke is guarded so it is a no-op on databases that don't have the function. Privileged functions such as `award_slot_xp`, `award_generated_recipe_xp`, `is_slot_unlocked` and `get_badges_earned_by_check_in` are called only from the AI server with the service role, never from the client.

The plan, badges and recipe book are derived from `check_ins` (migration `20261115000000_plan_badges_recipe_book.sql`). The app reads them through `get_my_plan()`, `get_my_plan_summary()`, `get_my_badges()` and `get_my_recipe_book()`. These take no user id and always use `auth.uid()`. Clients can insert check-ins (RLS-checked) but can't update or delete them, and the `technique_videos` cache is invisible to them.

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
| `SUPABASE_JWT_SECRET` | JWT secret for HS256 verification (provide this or the JWKS URI) |
| `SUPABASE_JWKS_URI` | JWKS URL for RS256 verification (provide this or the JWT secret) |
| `ALLOW_STUB_AUTH` | Dev only: accept any Bearer token. Forbidden when `NODE_ENV=production`. |
| `ENABLE_PREVIEW_ROUTE` | Dev only: enable the unauthenticated `/generate-preview` route. |
| `TRUST_PROXY` | Set to `true` when the server sits behind a reverse proxy. |
| `NODE_ENV` | `production` enables production checks (real auth and Supabase keys required). |
| `XP_AWARD_TIMEOUT_MS` | Timeout for each `award_slot_xp` call in ms (default `5000`, range `100`–`60000`). A timeout counts as a failed award. |
| `XP_RECONCILE_LOOKBACK_HOURS` | Reconcile job: how far back to look for check-ins missing XP (default `168`, range `1`–`720`). |
| `XP_RECONCILE_MIN_AGE_SECONDS` | Reconcile job: skip check-ins younger than this (default `120`, range `0`–`86400`). |
| `XP_RECONCILE_BATCH_LIMIT` | Reconcile job: most check-ins handled per run (default `100`, range `1`–`1000`). |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key for technique videos (F4). Server only. Unset: recipes have no videos. |
| `YOUTUBE_TIMEOUT_MS` | Timeout for each YouTube search in ms (default `5000`, range `100`–`60000`). |
| `VIDEO_LOOKUP_BUDGET_MS` | Time budget in ms for all of one recipe's YouTube searches together (default `8000`, range `100`–`60000`). Past it, the recipe is returned with the videos found so far and the rest are retried on the next visit. |
| `EXPO_PUBLIC_SUPABASE_URL` | App: Supabase project URL. In `app/.env.local`; bundled into the app, so public values only. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | App: Supabase anon (public) key. Never the service-role key. |
| `EXPO_PUBLIC_AI_SERVER_URL` | App: AI server base URL. Prefer an HTTPS tunnel (ngrok or Cloudflare) for phones; a LAN `http://` URL with `HOST=0.0.0.0` is for local dev. |
| `EXPO_PUBLIC_MOCK_MODE` | App: leave unset or `0` for the live backend; `1` = fake data, no backend; `ai` = real Supabase, fake AI server. |
| `EXPO_PUBLIC_MOCK_XP_STATUS` | App, mock mode only: check-in XP outcome to show (`awarded`, `failed` or `skipped`). |

### Retrying failed XP awards

If a check-in's XP award fails (for example a timeout), the check-in is kept without XP. To retry, run the reconcile job from `ai-server/` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in the environment:

```bash
cd ai-server
npm run build
npm run reconcile:xp -- --dry-run   # list check-ins missing XP, award nothing
npm run reconcile:xp                # award them via award_slot_xp
```

It's safe to run repeatedly. Nothing schedules it yet. See [ai-server/README.md](ai-server/README.md#reconcile-missing-xp-awards).
