# Simmer — instructions for every session

## PRD.md is the source of truth
- **Read `PRD.md` in full before doing any work.**
- Build only what is in the Features section (F1–F10), and meet each feature's acceptance criteria.
- **Do not add features or change decisions that are not in the PRD.** Nothing from the Out of scope section gets built.
- If the PRD is unclear or seems wrong, stop and ask. Do not guess. Propose PRD changes and wait for approval before acting on them.
- When you finish a feature, report which acceptance criteria are met and which are not.

## Git workflow (see PRD.md → Development workflow)
- Never commit or push directly to `main`.
- Before starting a feature or change, create a branch named after it, for example `feature/f1-signup-onboarding` or `fix/<short-description>`.
- When it's done, open a pull request into `main` with the feature (F#) and its acceptance-criteria status. Don't merge it yourself; a teammate reviews and approves it first.

## Layout
- `app/`: Expo (React Native, TypeScript) mobile app. Expo Router screens live in `app/src/app/`, and shared code lives in `app/src/lib/`. Also read `app/AGENTS.md` (Expo-specific rules: use `npx expo install`, check versioned Expo docs, Expo Router).
- `ai-server/`: Node + TypeScript (Express) proxy that runs on the team laptop next to Ollama. It verifies Supabase tokens, calls Ollama and the YouTube API, and writes to Supabase. It holds all secrets.
- `supabase/migrations/`: SQL migrations for the Supabase Postgres schema and row-level security.

## Rules from the PRD's tech constraints
- Secrets (Supabase service-role key, YouTube API key) live only in `ai-server/.env`. The app only gets `EXPO_PUBLIC_*` values (Supabase URL, anon key, AI server URL).
- XP and badges are awarded on the server side (database function or AI server), never trusted from the client.
- Ollama calls use JSON-schema structured output and validate the response.
- Cache YouTube search results per technique.

## Commands
- App: `cd app && npx expo start`, typecheck `npx tsc --noEmit`
- AI server: `cd ai-server && npm run dev`, typecheck `npm run typecheck`, health check `GET /health`
