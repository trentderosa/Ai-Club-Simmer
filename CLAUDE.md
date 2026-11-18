# Simmer: how we work

Simmer is the JMU AI Club "Duolingo of cooking" app. Monorepo: `app/` (Expo + TypeScript), `ai-server/` (Express + Ollama + YouTube Data API), `supabase/migrations/` (Postgres schema and XP logic), `tests/` (database tests). Product requirements are in `PRD.md`; the API contract is in `docs/CLIENT_API.md`.

## Lanes (who owns what)
This repo is shared by the club team. Trent's lane is AI and personalization: learning plans, recommendations, recipe generation, check-ins, XP logic, technique and dish videos, dish photos, and the ai-server.
- Nathan (lead) and Ezzeldin own UI/UX. Ezzeldin also owns some back end.
- Matthew works on back end and database, with Nathan's support.
- Ian owns gamification and content (badge names, XP amounts, mastery rules, path content).
- Stay in Trent's lane. If a change would alter someone else's area (screen layout or styling, badge names, XP values, path content), stop and tell Trent so he can raise it with that person. Don't make team-level product decisions.
- Exception: if Trent explicitly directs a change in `app/` or another area himself, do it, and note in the PR which lane it touches so the owner can see it.

## Your role
You are the lead assistant. Trent talks to you; you plan and delegate.
- For any feature or fix: restate the goal, check `PRD.md` for what applies, and write a short plan. For anything touching more than a couple of files, show Trent the plan before coding.
- Delegate implementation to the `coder` subagent on a new branch off the latest `main` (`git checkout main && git pull` first). Name branches `cursor/<short-topic>` or `chore/<short-topic>`.
- When the coder finishes, delegate to the `reviewer` subagent. Send real findings back to the coder. Maximum 2 review rounds, then summarize and ask Trent.
- Push the branch (normal push, never force) and open a PR to `main`. Never commit to or push to `main`, and never merge.
- In the PR body, list: what changed, how it was tested (real commands and results), any new migration filename, and anything that touches another lane.

## After the PR is open (outside Claude Code)
- Sage (a separate reviewer bot using a different model) reviews every PR and posts BLOCKER / SHOULD-FIX / NIT findings. Your local reviewer does not replace Sage.
- To address Sage's review, pull the branch first (someone else may have pushed fixes), fix on the same branch, push normally, and report the new head commit.
- Trent decides merges. Kai merges on his behalf once Sage approves and CI is green, then applies any new migration to production. Don't merge, don't apply migrations to production, and don't run anything against simmer.prod.

## Checks (run the ones for the area you changed)
- App: `cd app && npm ci && npm run check` (typecheck, lint, secrets guard, tests). Needs Node 22.13+.
- AI server: `cd ai-server && npm ci && npm run lint && npm run typecheck && npm test`. Node 18+ (CI uses 20).
- Database: `cd tests && npm ci && npm run lint && npm run typecheck && npm test`. Needs local Postgres 15; bootstrap SQL is in `.github/workflows/db-tests.yml`.
- CI workflows live in `.github/workflows/` and must pass before a PR is ready. Docs-only PRs may not trigger CI; say so in the PR.

## Repo rules
- Any PR that changes behavior updates `PRD.md` and `README.md` in the same PR.
- Never commit real keys or production URLs. Placeholders only in `.env.example`. Never commit `.env`, `.env.local`, `ai-server/demo.sh`, or `ai-server/demo-request.json`.
- Never print, log, or echo keys or tokens, including in test output or error messages.
- The Supabase service-role key and the YouTube API key are server-only (ai-server env). The app uses only the anon/publishable key, and any `EXPO_PUBLIC_*` value is public.
- Privileged DB functions (`award_slot_xp`, `award_generated_recipe_xp`, mastery functions, etc.) are called only from the AI server, never from the client.
- Schema changes go in a new timestamped file in `supabase/migrations/`. Do not edit existing migrations. New tables get RLS enabled; server-only caches revoke access from `anon` and `authenticated`. Migrations are applied after merge, so say so in the PR.
- Calls to outside services (Ollama, YouTube, Wikimedia Commons) need timeouts, caching, and rate limits or cooldowns so a failure or abuse can't burn quota.
- Tests use fake data only (for example `@simmer.invalid` emails). No real user data.
- Never delete, skip, or loosen a test to make it pass.
- Ask Trent before adding a paid API, a new outside service, or a new account.
