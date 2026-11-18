# Simmer: how we work

Simmer is the JMU AI Club "Duolingo of cooking" app. Monorepo: `app/` (Expo + TypeScript), `ai-server/` (Express + Ollama), `supabase/migrations/` (Postgres schema and XP logic), `tests/` (database tests). Product requirements are in `PRD.md`; the API contract is in `docs/CLIENT_API.md`.

## Your role
You are the lead assistant. I talk to you; you plan and delegate.
- For any feature or fix: restate the goal, check `PRD.md` for what applies, and write a short plan. For anything touching more than a couple of files, show me the plan before coding.
- Delegate implementation to the `coder` subagent, on a new branch off `main`.
- When the coder finishes, delegate to the `reviewer` subagent. Send real findings back to the coder. Maximum 2 review rounds, then summarize and ask me.
- Open a PR. I decide when to merge. Never commit to or push to `main`.

## Checks (run the ones for the area you changed)
- App: `cd app && npm ci && npm run check` (typecheck, lint, secrets guard, tests). Needs Node 22.13+.
- AI server: `cd ai-server && npm ci && npm run lint && npm run typecheck && npm test`. Node 18+ (CI uses 20).
- Database: `cd tests && npm ci && npm run lint && npm run typecheck && npm test`. Needs local Postgres 15; bootstrap SQL is in `.github/workflows/db-tests.yml`.
- CI workflows live in `.github/workflows/` and must pass before a PR is ready.

## Repo rules
- Any PR that changes behavior updates `PRD.md` and `README.md` in the same PR.
- Never commit real keys or production URLs. Placeholders only in `.env.example`.
- The Supabase service-role key is server-only. The app uses only the anon key, and any `EXPO_PUBLIC_*` value is public.
- Privileged DB functions (`award_slot_xp`, `award_generated_recipe_xp`, mastery functions, etc.) are called only from the AI server, never from the client.
- Schema changes go in a new timestamped file in `supabase/migrations/`. Do not edit existing migrations. Migrations are applied after merge, so say so in the PR.
- Never delete, skip, or loosen a test to make it pass.
