# Simmer client API (for the Expo app)

What the app calls for each MVP screen. There are two backends:

- **Supabase** (`supabase-js` with the **anon key** and the user's session): auth, the onboarding profile, and read-only RPCs for the plan, badges and recipe book.
- **AI server** (`fetch` with `Authorization: Bearer <supabase access token>`): recipe generation, videos, and check-ins (which award XP and badges).

The app never holds the service-role key or the YouTube key, and it never calls `award_slot_xp` or `award_generated_recipe_xp`.

| Screen | Call |
| --- | --- |
| Sign up / log in / log out (F1) | `supabase.auth.signUp / signInWithPassword / signOut` |
| Password reset (F1) | `supabase.auth.resetPasswordForEmail` (`redirectTo`: current web origin + Pages base path + `/reset-password`), then `supabase.auth.updateUser({ password })` on the recovery session |
| Onboarding, edit profile (F1) | `profiles` insert / update (own row) |
| Plan (F2, F7) | `rpc('get_my_plan')` + `rpc('get_my_plan_summary')` |
| Recipe + cook mode (F3, F4, F5) | AI server `POST /api/recipes/generate/:slotId` |
| Cook anything (F11) | AI server `POST /api/recipes/cook-anything`, then `user_generated_recipes` select for a saved recipe |
| Check-in (F6, F7, F9, F11) | AI server `POST /api/check-ins` (path: `user_recipe_id` + `slot_id`; free-form: `generated_recipe_id`) |
| Mastery challenge (F8) | Same recipe call on slot 10, plus `POST /api/mastery/sessions`, `POST /api/mastery/sessions/:id/reveal`, and `mastery_session_id` in the check-in |
| Badges (F9) | `rpc('get_my_badges')` |
| Recipe book (F10) | `rpc('get_my_recipe_book_v2')`; full recipe via the AI server (path) or `user_generated_recipes` (Cook anything); history via `check_ins` / `generated_recipe_check_ins` selects |

---

## F1. Sign-up and onboarding

Auth is plain Supabase email + password. After sign-up, insert the profile. RLS allows only your own row.

A signed-out user can request a password reset. `resetPasswordForEmail` redirects back to this app (`/reset-password` on the GitHub Pages base, or the local web origin). The recovery session sets a new password with `updateUser` before the plan or onboarding. Full mock mode shows the same confirmation, says it is practice mode, and does not call Supabase.

```ts
await supabase.from('profiles').upsert({
  id: session.user.id,
  goals: 'Cook 3 dinners a week',
  experience_level: 'never_cooked',       // 'never_cooked' | 'a_little' | 'comfortable'
  equipment: ['stove', 'pan', 'pot', 'knife', 'cutting board'],
  budget: 'low',                          // 'low' | 'medium' | 'high'
  days_per_week: 3,                       // 1-7
  minutes_per_session: 30,                // > 0
  onboarding_completed: true,
});
```

Routing rule: if `profiles.onboarding_completed` is not `true`, show onboarding. Otherwise go to the plan. The AI server refuses to generate recipes until onboarding is complete (404, "Please complete onboarding first").

## F2. Plan screen

```ts
const { data: slots } = await supabase.rpc('get_my_plan');
const { data: [summary] } = await supabase.rpc('get_my_plan_summary');
```

`get_my_plan()` returns 10 rows in path order:

| Field | Notes |
| --- | --- |
| `slot_id`, `slot_order`, `dish_name`, `technique_focus` | |
| `xp_value` | XP for a first completion |
| `is_final` | `true` only for slot 10 (mastery challenge) |
| `status` | `'done'`, `'current'` or `'locked'`. Only `current` and `done` can be opened. |
| `has_recipe` | A recipe is already generated and saved |
| `times_completed`, `first_completed_at` | |

`get_my_plan_summary()` returns one row:

| Field | Notes |
| --- | --- |
| `total_xp` | Show on the plan screen (F7). Includes path-slot XP and free-form (Cook anything) XP. |
| `completed_slots`, `total_slots`, `current_slot_order`, `path_complete` | |
| `suggested_sessions_per_week` | From the onboarding schedule. `null` until the schedule is set |
| `estimated_weeks_remaining` | |

Suggested sessions = `floor(days_per_week × minutes_per_session ÷ average cook minutes of the remaining recipes)`, kept between 1 and `days_per_week`. This rule is a proposal (PRD open question 11).

## F3–F5. Recipe and cook mode

```
POST {AI_SERVER}/api/recipes/generate/:slotId
Authorization: Bearer <access_token>
```

The first call generates the recipe with Ollama, which can take 10–60 s, so show a loading state. Later calls return the saved recipe instantly (`cached: true`). An unknown slot is 404 even if a saved recipe exists, so hidden steps are never returned unmasked. After a path check-in the server may already have saved the next recipe in the background, so the first open can return quickly with `cached: true`. No request or response change.

```jsonc
{
  "recipe": {
    "title": "Fluffy Scrambled Eggs",
    "ingredients": [{ "name": "eggs", "amount": "2" }],
    "timeEstimateMinutes": 10,
    "coachNote": "Last time heat control was tricky, so keep the pan on low.", // optional (F6)
    "steps": [
      {
        "instruction": "Whisk the eggs with a pinch of salt.",
        "whyItMatters": "Air makes them fluffy.",   // optional
        "isSafetyStep": false,                     // true: red border + "Safety" label (F5)
        "techniqueName": "Whisk eggs"              // optional, key into videos
      }
    ]
  },
  "cached": false,
  "videos": {
    "Whisk eggs": { "videoId": "abc123XYZ_-", "title": "How to whisk eggs", "channelTitle": "..." }
  }
}
```

- **Videos (F4):** use `videos[step.techniqueName]`. A step with no entry has no video. `dish_videos` is 0–3 videos of someone making this dish ("Watch someone make it"); hide that section when it is missing or empty. Open a video with React Native `Linking` only when the URL is on the allowlist: `https://www.youtube.com`, `https://youtube.com`, `https://m.youtube.com`, `https://youtu.be` (the server sanitizes to the same list). Thumbnail: `https://i.ytimg.com/vi/{videoId}/hqdefault.jpg`. `videos` is `{}` when the server has no YouTube key or the search failed, and can be partial when some searches failed. The server retries the missing technique videos the next time the recipe is loaded through the AI server. A failed dish-video search is not cached (it is cooled down, and a quota error pauses further dish and technique searches until the quota resets, including after an AI server restart) and the section stays hidden. Mock placeholder videos are not openable. The YouTube key is not in the app.
- **Errors:**
  - `401`: bad or expired token.
  - `403 { code: "SLOT_LOCKED" }`: the slot isn't unlocked yet.
  - `404`: unknown slot, or onboarding isn't finished.
  - `500`: generation failed after 3 tries. Show a **Retry** button (F3).
  - `503 { code: "GENERATION_BUSY" }` with a `Retry-After` header (seconds): the model queue is full, the wait ran out, or the per-request time budget (`OLLAMA_REQUEST_BUDGET_MS`) ran out. Nothing was generated and the call is not retried server side. Show a short message and a way to try again.
  - `429`: rate limited.


## F11. Cook anything

```
POST {AI_SERVER}/api/recipes/cook-anything
Authorization: Bearer <access_token>
Content-Type: application/json

{ "dish": "pad thai" }
```

The first call generates a recipe with Ollama (10–60 s) and looks up videos the same way as a path slot. It also looks up one still photo of the dish on Wikimedia Commons (no API key, ~2.5 s timeout). Only CC0, public domain, CC BY, or CC BY-SA images on `https://upload.wikimedia.org/` are accepted. A miss, timeout, or failure returns `photo: null` and never fails generation. Later calls for the same user and normalized dish name return the saved recipe instantly (`cached: true`), including a stored photo when one was found. The dish is trimmed, capped at 80 characters, and rejected when empty, junk, or injection-like. Normalization is lowercase, trimmed, collapsed whitespace, punctuation stripped.

```jsonc
{
  "generated_recipe_id": "<uuid>",
  "dish_query": "pad thai",
  "normalized_dish_name": "pad thai",
  "recipe": { /* same shape as F3 */ },
  "cached": false,
  "videos": { /* same shape as F3 */ },
  "photo": {
    "url": "https://upload.wikimedia.org/wikipedia/commons/…/Pad_Thai.jpg",
    "credit": {
      "author": "Jane Cook",
      "license": "CC BY-SA 4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
      "sourceUrl": "https://commons.wikimedia.org/wiki/File:Pad_Thai.jpg"
    }
  },
  "xp_value": 84,
  "counts": { "steps": 5, "ingredients": 6, "minutes": 20 }
}
```

`xp_value` is computed with the path-slot formula from clamped counts of the validated recipe arrays (steps 1–10, ingredients 1–12, minutes 1–45) and is frozen on first save. The recipe body itself is not truncated. The mock canned recipe (5 / 6 / 20) has `xp_value` 84; a 50 / 80 / 999 model response keeps the full recipe and stores `xp_value` 177, below roast chicken (181). A later check-in awards that value subject to the 50% repeat rule, the shared weekly repeat cap, and the daily cap (`freeform_daily_cap`, default 200). A lone max award of 177 is under the cap; the cap still applies when today's slot XP plus free-form XP would exceed 200.

Reload a saved recipe (own row only, RLS) with:

```ts
const { data } = await supabase
  .from('user_generated_recipes')
  .select('id, dish_query, normalized_dish_name, recipe_json, video_ids, photo_json, xp_value, step_count, ingredient_count, time_estimate_minutes')
  .eq('id', generatedRecipeId)
  .single();
```

`photo` is `null` when no acceptable Commons image was found or the lookup timed out. Show `board.jpg` in that case, and if a remote image fails to load. The credit line is `Photo: <author> · <license>`; on the recipe hero, tap it to open `credit.sourceUrl` (a Commons file page) when present. Recipe-book row thumbnails omit the line on the image and show it under the row byline; the detail screen, the featured photo, and recipe heroes still show it. Path recipe responses include the same `photo`. Today and the recipe book load photos with `POST /api/dish-photos` `{ dishes: string[] }` → `{ photos: { [normalizedDishName]: photo | null } }` (authenticated, at most 12 names, rate limited per IP before auth and per user after auth; either returns `429`). Only names from the caller's path and Cook anything recipes are looked up; other names come back as null. `photo_json` on a saved Cook anything row is the same shape, or null until a photo is stored. The `dish_photos` cache is server-only; a genuine miss is stored and retried after 7 days.

- **Errors:**
  - `401`: bad or expired token.
  - `400 { code: "INVALID_DISH" }`: empty, too long, junk, or rejected input.
  - `404`: onboarding isn't finished.
  - `429`: per-user uncached generation rate limit (default 5 per hour). The count is stored in the database and survives an AI server restart. Cache hits are not limited.
  - `503 { code: "GENERATION_RATE_LIMIT_UNAVAILABLE" }`: the generation limit could not be checked, so a new recipe was not started. A saved dish still loads. This is not the auth-service 503.
  - `503 { code: "GENERATION_BUSY" }` with a `Retry-After` header (seconds): the model queue is full, the wait ran out, or the per-request time budget (`OLLAMA_REQUEST_BUDGET_MS`) ran out. A request refused because the queue is already full does not count toward the per-user generation limit. A request that waited in the queue and timed out, or that went busy on a later try, still counts as one of the 5 per hour. Show a short message and a way to try again.
  - `500`: generation failed after 3 tries. Show a **Retry** button.

To check in, `POST /api/check-ins` with `generated_recipe_id` instead of `user_recipe_id` / `slot_id` (do not send both). The same idempotency rules apply. Repeats of that normalized dish earn 50% XP and share the 100 XP/week repeat cap with path-slot repeats. Free-form awards also apply a daily cap (default 200) that counts today's slot XP and free-form XP together.

## F6, F7, F9. Check-in

```
POST {AI_SERVER}/api/check-ins
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "user_recipe_id": "<user_recipes.id>",   // path check-in
  "slot_id": 2,                           // path check-in
  "generated_recipe_id": "<uuid>",        // free-form check-in (F11); do not send with slot_id
  "rating": "hard",                 // 'easy' | 'ok' | 'hard'
  "went_well": "Nice texture",      // optional, max 500 chars
  "was_hard": "Heat control",       // optional, max 500 chars
  "mastery_session_id": "<uuid>",   // slot 10 only (F8): from POST /api/mastery/sessions
  "idempotency_key": "<uuid>"       // optional; required for safe retries (see below)
}
```

For a path check-in, send `user_recipe_id` and `slot_id`. For a Cook anything check-in, send `generated_recipe_id` instead (the row in `user_generated_recipes`; RLS returns only your rows). Do not mix the two shapes.

`user_recipe_id`: read it with `supabase.from('user_recipes').select('id').eq('slot_id', slotId).single()` (RLS returns only your rows). Clients can select `id`, `user_id`, `slot_id`, `video_ids` and `created_at` from `user_recipes`, but not `recipe_json`; recipes come from the AI server.

`idempotency_key` is a client-generated UUID, unique for one check-in attempt. The server stores it as `check_ins.id` (the existing primary key; no new column). Send the same key if you retry after a timeout or drop: the first write wins, a second POST with that key returns the original check-in and does not insert another row or award XP again (`award_slot_xp` is already `UNIQUE(check_in_id)`). A replay also skips a second Coach's note generation and returns a short "already saved" note. A key that already belongs to a different user, recipe, or slot returns `409 { code: "IDEMPOTENCY_CONFLICT" }`. Older clients that omit the key keep the previous behavior (a new id each time). After a timeout, the client should re-read `get_my_plan()` and only re-POST if this slot's `times_completed` did not go up.

**All ids must be real UUIDs.** Every id the client sends (`user_recipe_id`, `generated_recipe_id`, `mastery_session_id`, `idempotency_key`, and the session id in `/api/mastery/sessions/:sessionId/reveal`) must be an RFC 9562 / RFC 4122 UUID. The server validates with zod v4's `z.string().uuid()`, which checks the version and variant bits, so an arbitrary 36-character hex string with dashes is rejected. A bad id in a check-in body returns `400 { code: "VALIDATION_ERROR" }`; a bad session id in a mastery path returns `400 { code: "VALIDATION_ERROR" }` too (before any lookup, so it never reaches `404`). Generate `idempotency_key` with `crypto.randomUUID()` (web) or `randomUUID()` from `expo-crypto`.

Response `201`:

```jsonc
{
  "check_in_id": "...",
  "coach_note": "Nice work! Next time, try ...",
  "focus_area": "heat control",
  "xp": { "status": "awarded", "xp_awarded": 62, "is_first_completion": true, "capped": false },
  "badges": { "status": "ok", "earned": [
    { "code": "complete_slot_2", "name": "Scrambled Eggs", "description": "...", "kind": "completion" }
  ] },
  "suggest_repeat": true
}
```

- **XP (F7):** show `+xp_awarded`. If `capped` is true on a repeat, say that the weekly repeat cap has been reached and this repeat earned 0 XP (or only part of its usual XP). `xp.status: "failed"` means the check-in was saved but the award is retried later. Don't show an error.
- **Badges (F9):** play a short celebration for each badge in `badges.earned`. A repeat earns nothing new.
- **Repeat suggestion (F6):** if `suggest_repeat` is true, ask "That one was tough. Cook it again before moving on?" **Cook again** reopens the same slot, which is allowed because done slots stay open. **Skip** goes back to the plan. The path never changes either way.
- **Errors:**
  - `400 INVALID_RECIPE`: the recipe doesn't belong to the user or the slot.
  - `400 MASTERY_NOT_ALLOWED`: `mastery_session_id` was sent on a slot other than 10.
  - `400 INVALID_MASTERY_SESSION`: the session belongs to a different user, slot or recipe.
  - `409 MASTERY_SESSION_USED`: that session already backs another check-in. Start a new one.
  - `400 VALIDATION_ERROR`
  - `409 IDEMPOTENCY_CONFLICT`: the key was already used for a different check-in
  - `401`
  - `429`

After a check-in, re-fetch `get_my_plan` and `get_my_plan_summary`: the next slot is now `current`.

## F8. Mastery challenge (slot 10)

The recipe call for slot 10 returns every non-safety step **masked**: `instruction` is a placeholder, `whyItMatters` is left out, and the step has `isHidden: true`. `techniqueName` stays, so the video can still show. Safety steps (`isSafetyStep: true`) come back in full.

When cook mode opens, start or resume the mastery session:

```
POST {AI_SERVER}/api/mastery/sessions
Authorization: Bearer <access_token>
{ "slot_id": 10 }
```

Response `201`:

```jsonc
{
  "session_id": "<uuid>",
  "hidden_step_indices": [2, 3, 5],          // 0-based
  "revealed_steps": { "3": { "instruction": "...", "isSafetyStep": false } }  // already revealed in this session
}
```

The server keeps one open session per user until a check-in uses it. Calling this again (after an app restart, say) returns the same session with its reveals, so the count can't be reset. Errors: `400 SLOT_NOT_FINAL`, `404 RECIPE_NOT_FOUND` (open the recipe first), `403 SLOT_LOCKED`, `401`, `429`.

To reveal a step:

```
POST {AI_SERVER}/api/mastery/sessions/{session_id}/reveal
Authorization: Bearer <access_token>
{ "step_index": 3 }
```

Response `200`: `{ "step_index": 3, "step": { ...full step... }, "hidden_step_indices": [...], "revealed_step_indices": [...] }`. The server records the reveal before it sends the text, and repeating a reveal is safe. Errors: `400 STEP_NOT_HIDDEN` (a safety step or out-of-range index), `404 MASTERY_SESSION_NOT_FOUND`, `409 MASTERY_SESSION_USED` (already checked in).

Show "Revealed X of Y hidden steps", where Y is `hidden_step_indices.length` and X is the number of steps revealed. Send `mastery_session_id` with the check-in. The server copies the counts from the session; the app never sends them. Finishing and checking in completes the slot (XP and the book entry labeled Mastered are unchanged). The `mastery` badge is awarded only when the session has zero reveals. A check-in without a session earns no badge. Finishing slot 10 last also earns `path_weeknight_basics`.

The old `mastery: { hidden_steps, revealed_steps }` field is still accepted so older builds don't fail, but it is ignored.

## F9. Badges screen

```ts
const { data: badges } = await supabase.rpc('get_my_badges');
// [{ code, name, description, kind: 'completion'|'mastery'|'path_milestone', slot_id, sort_order, earned, earned_at }]
```

Show `earned: false` badges grayed out.

## F10. Recipe book

```ts
const { data: book } = await supabase.rpc('get_my_recipe_book_v2');
// [{ slot_id, slot_order, dish_name, user_recipe_id, recipe_title, label: 'completed'|'mastered', added_at, times_cooked,
//    kind: 'path'|'cook_anything', generated_recipe_id, last_cooked_at, last_difficulty_rating }]
```

`get_my_recipe_book()` still exists with its original path-only shape for older app builds. New clients call `get_my_recipe_book_v2()` and fall back to the original only if v2 is missing (database not migrated yet).

The book lists path recipes you have checked in on and Cook anything dishes (F11) that have at least one check-in, each once. Path entries come first in path order; sort for display as you like.

| Field | Path entry | Cook anything entry |
| --- | --- | --- |
| `kind` | `'path'` | `'cook_anything'` |
| `slot_id`, `slot_order` | set | `null` |
| `user_recipe_id` | the saved recipe (can be `null`) | `null` |
| `generated_recipe_id` | `null` | `user_generated_recipes.id` |
| `dish_name` | the path dish | the dish the user typed |
| `recipe_title` | recipe title, else the dish | recipe title, else the typed dish |
| `label` | `'completed'`, or `'mastered'` for slot 10 | `'completed'` |
| `added_at` | first check-in | first check-in |
| `times_cooked` | check-ins on the slot | check-ins on the recipe |
| `last_cooked_at`, `last_difficulty_rating` | newest check-in | newest check-in |

If the list is empty, show: "Cook a recipe and finish the check-in to add it to your recipe book."

Read-only full recipe: open the entry's slot with `POST /api/recipes/generate/:slotId` (F3). For a completed slot it returns the saved recipe (`cached: true`, nothing is regenerated), with `videos`, `dish_videos` and `photo`, and slot 10 steps stay masked. The app does this by opening `/book-entry/path/[id]`.

Read-only Cook anything recipe: select it from `user_generated_recipes` by `generated_recipe_id` (the app does this on `/book-entry/cook-anything/[id]`; Cook again goes to `/generated-cook/[recipeId]`).

Check-in history ("Your cooks"): RLS lets you read only your own rows, newest first.

```ts
// path entry
await supabase.from('check_ins')
  .select('id, difficulty_rating, went_well, was_hard, created_at')
  .eq('slot_id', entry.slot_id).order('created_at', { ascending: false });
// Cook anything entry
await supabase.from('generated_recipe_check_ins')
  .select('id, difficulty_rating, went_well, was_hard, created_at')
  .eq('generated_recipe_id', entry.generated_recipe_id).order('created_at', { ascending: false });
```

`went_well` and `was_hard` can be `null`; hide them when empty.

Do not read `recipe_json` from `user_recipes` directly: clients can't select that column (migration `20261116000000_mastery_sessions.sql`), so slot 10 hidden steps can't leak. The request returns `403`.

## What the client must not do

- Call `award_slot_xp`, `award_generated_recipe_xp`, `is_slot_unlocked` or `get_badges_earned_by_check_in`. These are service-role only, and the database refuses them from the app.
- Write `xp_events`, `generated_recipe_xp_events`, `user_slot_completions`, `user_recipes`, `user_generated_recipes`, `badges` or `technique_videos`, or update or delete `check_ins`. All of these are blocked.
- Ship the service-role key or the YouTube key in the app.
