# Simmer app (Expo)

The Expo + TypeScript client for Simmer. It covers the **core loop** (sign up or sign in → onboarding → Today → recipe → cook mode → check-in → session complete) plus the **mastery challenge** on slot 10, **Cook anything** from Today, the **recipe book** and the **profile**, with a small bottom bar to switch between Today, the book and You. It implements UI **Direction A, "editorial kitchen"** from the design proposal.

Nathan owns UI/UX (Ian and Ezzeldin help). Treat this as a handoff-ready starting point: the screens follow the mockups, but every visual decision is theirs to change. The backend contract is [`../docs/CLIENT_API.md`](../docs/CLIENT_API.md).

## Run it

Requires Node.js 22.13+ (or 24.3+), which Expo SDK 58 and React Native 0.88 need.

```bash
cd app
npm ci
npm run web:mock        # fake data in the browser, no Supabase or ai-server needed
npm run start:mock      # same, for Expo Go / a simulator (press i / a, or scan the QR code)
```

In mock mode any email works. **Sign in** loads a demo cook (Jordan, 3 of 10 dishes done, 239 XP, three recipes in the book, three badges). Sign in as `mastery@simmer.test` (any password) loads a second canned user (Riley, 9 of 10 done, 917 XP) already at the Roast Chicken mastery challenge. **Create account** starts a fresh user who goes through onboarding. Mock state lives in memory and resets on reload. The ten canned path recipes follow the same food-safety rules as generated ones: raw chicken is patted dry, never rinsed; both chicken dishes give 165°F in the thickest part; and every knife step is a safety step, so it stays visible in the mastery challenge. The mock Roast Chicken has 8 steps with 3 hidden.

Against the real backend:

```bash
cp .env.example .env.local   # fill in the Supabase URL + anon key and the ai-server URL
npm start
```

On a phone, `EXPO_PUBLIC_AI_SERVER_URL` must be reachable from the phone. Prefer an HTTPS tunnel (ngrok or Cloudflare Tunnel; see the PRD) so the access token isn't sent over plain HTTP on the LAN, and so iOS release builds aren't blocked by App Transport Security. A LAN URL like `http://192.168.1.20:3001` (start the ai-server with `HOST=0.0.0.0`) is fine for local development. `127.0.0.1` only works in a simulator on the same machine.

The Expo web build can talk to the live AI server from origins in `ALLOWED_ORIGINS` (default: `http://localhost:8081`, `http://127.0.0.1:8081`, `http://localhost:19006`, and `http://127.0.0.1:19006`). The Pages site needs `https://trentderosa.github.io` on that list before mock mode is turned off. See [GitHub Pages](#github-pages).

## Environment

Expo inlines every `EXPO_PUBLIC_*` value into the app bundle, so **only public values go here**. The service-role key and the YouTube key stay on the ai-server.

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key. RLS limits each user to their own rows. |
| `EXPO_PUBLIC_AI_SERVER_URL` | ai-server base URL. Prefer an HTTPS tunnel for phones; a LAN `http://…` URL is for local dev. |
| `EXPO_PUBLIC_MOCK_MODE` | `1`, `true`, or `all` = fake everything (no network). `ai` = real Supabase, fake ai-server. Unset or `0` = live. |
| `EXPO_PUBLIC_MOCK_XP_STATUS` | Mock only: the check-in's `xp.status`, `awarded` (default), `failed` or `skipped`. Use it to see the honest "XP pending" screen. |

If a required value is missing, blank, or not an `http`/`https` URL, the app shows the setup screen that names it and does not start the live backend.

## GitHub Pages

The public site is `https://trentderosa.github.io/Ai-Club-Simmer/`, published by `.github/workflows/web-deploy.yml`. The workflow defaults to mock mode. When the repository variable `EXPO_PUBLIC_MOCK_MODE` is unset, the build sets it to `1`. The site stays on that mock build until the variables below are set and a later build succeeds. This repo does not turn mock mode off.

Set these as GitHub **repository variables** (Settings → Secrets and variables → Actions → Variables). They are public: Expo inlines every `EXPO_PUBLIC_*` value into the bundle. Use the anon key only. The service-role key and the YouTube key stay on the AI server, never in a repository variable.

| Variable | Value when leaving mock mode |
| --- | --- |
| `EXPO_PUBLIC_MOCK_MODE` | `0` |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL, `https://<project-ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key |
| `EXPO_PUBLIC_AI_SERVER_URL` | AI server base URL browsers can reach (an HTTPS tunnel) |

`1`, `true`, and `all` stay on the full mock and do not read the other three. `ai` uses real Supabase and a fake AI server, so the build requires the Supabase URL and the anon key. Any other value, including `0`, is live and requires all three.

`app/scripts/check-pages-config.mjs` runs before the export. The build fails, and the last good deploy stays up, when a required value is blank, not `https`, a placeholder from `.env.example` (`your-project-ref.supabase.co`, `your-anon-key`), or a loopback host (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`). Plain `http` is rejected there because the Pages site is https. Loopback would point the public site at the visitor's own machine. The log names the variables and does not print the values. A value that looks like a server-only Supabase key fails the build the same way.

Before the first live build, allow the Pages site through Supabase and the AI server:

- **Supabase redirect URLs** (Authentication → URL configuration → Redirect URLs): `https://trentderosa.github.io/Ai-Club-Simmer/**`
- **Supabase Site URL**: `https://trentderosa.github.io/Ai-Club-Simmer` (the app does not send its own email redirect, so confirmation links use the Site URL)
- **AI server `ALLOWED_ORIGINS`**: `https://trentderosa.github.io`

`https://trentderosa.github.io` is the browser origin of the Pages URL `https://trentderosa.github.io/Ai-Club-Simmer/`. `ALLOWED_ORIGINS` entries are scheme and host only. A path on that entry is rejected when the AI server starts.

Local `npm start` still accepts an `http` URL, including loopback, for LAN dev. The setup screen is only for a missing or non-`http(s)` value.

`npm run check:secrets` (also in `npm run check`) fails if anything in `app/` mentions the service role, contains a JWT with `role: service_role`, or contains an `sb_secret_` key. An ESLint rule blocks the same names in code. `app/app.config.ts` reads `app.json` and sets the web `baseUrl` only when `EXPO_BASE_URL` is set (for example `/Ai-Club-Simmer`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (`eslint-config-expo` + the service-role rule), zero warnings allowed |
| `npm test` | Jest (`jest-expo`): API parsing, XP mapping, timer, highlighting, mock backend |
| `npm run check:secrets` | Service-role guard (see above) |
| `npm run check` | All four, as CI runs them |
| `npm run export:web:mock` | Static web build in mock mode, into `dist/` |
| `npm run export:web:pages` | Web build for GitHub Pages under `/Ai-Club-Simmer` (or `EXPO_BASE_URL`), plus `404.html` and `.nojekyll` |
| `npm run check:secrets:dist` | Scans `dist/` for the same service-role patterns. Prints paths and kinds, never values |

## Structure

```
app/
├── src/app/                 # Routes (Expo Router). Screens only: layout + wiring, no fetch calls.
│   ├── _layout.tsx          # Fonts, providers, auth/onboarding guards (Stack.Protected)
│   ├── (tabs)/              # Today (plan + Cook anything), recipe book, profile (You). Tab visuals: components/tab-bar.tsx
│   ├── sign-in.tsx          # F1 sign up / sign in
│   ├── onboarding.tsx       # F1 steps 2-4 -> profiles
│   ├── cook-anything.tsx    # F11 type a dish (loading / empty / error)
│   ├── edit-profile.tsx     # F1 edit onboarding answers (same form, same columns)
│   ├── recipe/[slotId].tsx  # F3/F4/F6 recipe, coach's note, technique videos
│   ├── cook/[slotId].tsx    # F5 cook mode with timer
│   ├── check-in/[slotId].tsx# F6 check-in
│   ├── complete/[slotId].tsx# F6/F7/F9 XP, badges, coach reply, repeat suggestion
│   ├── generated/[recipeId].tsx
│   ├── generated-cook/[recipeId].tsx
│   ├── generated-check-in/[recipeId].tsx
│   └── generated-complete/[recipeId].tsx
├── src/api/                 # Typed backend layer. The only code that talks to Supabase or the ai-server.
│   ├── backend.ts           # The Backend interface screens use
│   ├── live-backend.ts      # Supabase (anon key + session) + ai-server
│   ├── ai-server.ts         # fetch client for /api/recipes and /api/check-ins
│   ├── schemas.ts           # zod schemas for every response (parsed at the boundary)
│   ├── errors.ts            # ApiError with a `kind` per CLIENT_API error case
│   └── mock/                # Mock mode: fixtures + an in-memory backend that follows the server rules
├── src/domain/              # Pure logic (tested): XP result mapping, timer, ingredient highlighting, copy
├── src/state/               # Session/guard state, a small async loader, the in-flow cache
├── src/components/          # Design-system pieces: T (type), Button, path, seal, timer card, states
├── src/theme/               # tokens.ts (from design-tokens.md) and the font list
└── assets/photos/           # CC0 dish photos, see CREDITS.md
```

Rules of thumb for the next person:
- Screens get data only through `useSession().backend` (or the hooks in `state/`), never from supabase-js or `fetch` directly.
- Every color, size and font comes from `theme/tokens.ts`; text goes through `<T variant=...>`.
- Each screen has a loading, an error and (where it applies) an empty state, from `components/states.tsx`.

## How the screens map to the API

| Screen | Call |
| --- | --- |
| Sign in / up / out | `supabase.auth.signInWithPassword / signUp / signOut`. The first name goes in auth `user_metadata.first_name` because `profiles` has no name column. |
| Onboarding | `profiles` upsert (own row): `goals`, `experience_level`, `equipment`, `budget`, `days_per_week`, `minutes_per_session`, `onboarding_completed: true`. The mockup's diet question is left out (no column yet). |
| Routing | `profiles.onboarding_completed !== true` → onboarding, otherwise Today |
| Today | `rpc('get_my_plan')` + `rpc('get_my_plan_summary')`, re-read on focus. "Cook anything" opens `/cook-anything`. |
| Recipe book | `rpc('get_my_recipe_book_v2')` (falls back to `get_my_recipe_book` if v2 isn't migrated yet) + `get_my_plan` (for technique names and "Still to come"). The book also lists Cook anything dishes that have a check-in, with a small "Cook anything" tag. Tapping an entry opens a read-only detail screen (`/book-entry/[kind]/[id]`) with the recipe, the user's own check-ins ("Your cooks", read from `check_ins` / `generated_recipe_check_ins`) and a Cook again button into the existing cook flow. Repeats earn 50% XP, which the book and a done recipe both say. |
| Profile / You | First name from auth `user_metadata.first_name`. `rpc('get_my_plan_summary')` for XP and path progress, `rpc('get_my_badges')` for the shelf (unearned seals are grayed out), `profiles` for onboarding answers and `created_at` ("Cooking since …"). Edit reuses the onboarding steps and upserts the same columns. Sign-out lives here. |
| Recipe, cook mode | ai-server `POST /api/recipes/generate/:slotId` with `Authorization: Bearer <access token>`. `videos[step.techniqueName]`; missing entries mean no video, `null` is treated as `{}`. Slot 10 (`is_final`) comes back with non-safety steps masked (`isHidden: true`). Cook mode first calls `POST /api/mastery/sessions`, which starts or resumes the server session. Each Reveal calls `POST /api/mastery/sessions/:id/reveal` for the step's real text, and the screen shows "Revealed X of Y hidden steps." The mastery seal needs zero reveals; revealing a step still finishes the slot. |
| Cook anything | ai-server `POST /api/recipes/cook-anything` with `{ dish }`. Cache hits reuse the first recipe for that normalized name (`xp_value` frozen; the mock canned recipe is 84). Then `user_generated_recipes` select for later visits, and the generated recipe / cook / check-in / complete screens. A later check-in awards that `xp_value` subject to the daily cap (default 200). |
| Check-in | Path: `user_recipes.select('id').eq('slot_id', …)`, then ai-server `POST /api/check-ins` with `user_recipe_id` + `slot_id`. For slot 10, send `mastery_session_id` from cook mode. The server reads the reveal counts from the session, and the app never sends counts. Without a session (cook mode skipped) no badge is earned. The badge is awarded only when the session has zero reveals. Free-form: `POST /api/check-ins` with `generated_recipe_id`. Both use a per-attempt `idempotency_key` (reused on Retry; minted with `expo-crypto`). After a path-check-in timeout, the screen re-reads `get_my_plan()` and skips a second POST if `times_completed` already went up. If the save takes more than about 15 seconds, it shows that the coach is writing a note. |
| Session complete | The 201 response (`xp`, `badges`, `coach_note`, `focus_area`, `suggest_repeat`), plus `get_my_plan_summary` / `get_my_plan` read right before and after |

XP is shown honestly: `awarded` shows `+N` (and explains repeats and the weekly cap), `failed` says the check-in is saved and the XP is on its way with no number, `skipped` says XP isn't configured on that server.

## Design notes

- Fonts: Fraunces (300, 400, 400 italic, 500, 600) and Source Sans 3 (400, 600, 700) from `@expo-google-fonts`, each a static file per weight. The mockup's Fraunces 450 for cook-mode steps uses 400, the nearest static cut.
- Photos are CC0 from Wikimedia Commons (`assets/photos/CREDITS.md`) and stand in for dishes; recipes don't have their own photos. A Commons credit line stays on recipe heroes and the recipe book's featured photo. List thumbnails leave it off the image and show it under the row byline.
- Video thumbnails come from `i.ytimg.com`. Tapping opens an allowlisted YouTube URL with React Native `Linking` (`https://www.youtube.com`, `https://youtube.com`, `https://m.youtube.com`, `https://youtu.be`). In mock mode the ids are fake, so a local placeholder image is shown, the row is disabled, and nothing opens (no crash, no error toast).
- The path's zig-zag offsets are a little narrower than the mockup's so long dish names fit with the static Fraunces cut.

## Not in this PR

Leagues, streaks and the week row, cooking levels (L1–L4; the profile shows experience level, XP and path progress instead), step ordering, and hands-free/voice cook mode. The bottom bar is a minimal handoff for Nathan: restyle `src/components/tab-bar.tsx`. The mastery badge needs zero reveals (PRD Q4, pending Ian's OK).

## Known gaps

- **Web against the live ai-server:** the web build can use the real backend when the page origin is in the AI server's `ALLOWED_ORIGINS` allowlist (the default is Expo's localhost/127.0.0.1 dev origins on ports 8081 and 19006; see the root README and `ai-server/README.md`). The Pages origin to add is `https://trentderosa.github.io`. Other origins get no CORS headers. iOS/Android aren't affected.
- **`EXPO_PUBLIC_MOCK_MODE=ai`:** recipes and check-ins are fake and nothing is written to Supabase, so the real plan doesn't advance after a mock check-in.
- Sessions are stored with AsyncStorage (localStorage on web), which isn't encrypted. Supabase's session can exceed SecureStore's size limit; a "large secure store" wrapper is the usual fix if we want encryption at rest.
- App icon and splash are the Expo template placeholders.
