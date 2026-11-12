# Simmer

Simmer is the JMU AI Club "Duolingo of cooking" app for new cooks. The MVP is a single fixed path, **"Weeknight basics"**: 10 weeknight dishes in a set order, each teaching a technique, with check-ins, XP, and AI-tailored tips after each cook.

This repo holds the product requirements, the AI server, and the database migrations and tests. The Expo client is not in the repo yet.

See [PRD.md](PRD.md) for the full MVP requirements. Every PR that changes behavior updates `PRD.md` and `README.md` in the same PR.

## Repo layout

```
.
├── PRD.md                 # Product requirements (MVP)
├── README.md
├── ai-server/             # Express AI server (local Ollama recipes, check-ins)
├── supabase/migrations/   # Postgres / Supabase schema and XP logic
├── tests/                 # Database tests for the schema and XP awards
└── .github/workflows/     # AI Server CI and Database Tests
```

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

`DATABASE_URL` defaults to that value if unset. Lint and typecheck: `npm run lint` and `npm run typecheck`.

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
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window (default `60000`) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window (default `10`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server only; never ship to the client) |
| `SUPABASE_JWT_SECRET` | JWT secret for HS256 verification (provide this or the JWKS URI) |
| `SUPABASE_JWKS_URI` | JWKS URL for RS256 verification (provide this or the JWT secret) |
| `ALLOW_STUB_AUTH` | Dev only: accept any Bearer token. Forbidden when `NODE_ENV=production`. |
| `ENABLE_PREVIEW_ROUTE` | Dev only: enable the unauthenticated `/generate-preview` route. |
| `TRUST_PROXY` | Set to `true` when the server sits behind a reverse proxy. |
| `NODE_ENV` | `production` enables production checks (real auth and Supabase keys required). |
| `DATABASE_URL` | Postgres URL for the database tests (see above). |
