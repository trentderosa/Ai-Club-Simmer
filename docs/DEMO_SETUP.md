# Demo setup runbook

How to stand up Simmer for the showcase. The setup is one laptop running Ollama and the AI server, a Supabase free-tier project, and phones running the Expo app on the same Wi-Fi or through a tunnel (PRD §6).

Owner: TBD (PRD open question 2). Keep every key in `ai-server/.env` on the demo laptop only, never in the repo or chat.

## 1. GitHub (one time)

- **Branch protection on `main`:** Settings → Branches → Add rule for `main`. Turn on *Require a pull request before merging* and *Require approvals: 1* (PRD §6).
  - PRs are reviewed by AI on this team. GitHub doesn't count an approval from the PR's own author, so the required approval must come from a different GitHub account (a teammate or a review bot). Otherwise an admin has to bypass the rule to merge.

## 2. Supabase project (one time)

1. Create a free project at supabase.com. Note the project URL.
2. Apply the migrations **in filename order** from `supabase/migrations/`. Use the SQL editor (paste each file), or the CLI:

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push
   ```

3. **Auth:** email + password provider on. For the demo, consider turning off "Confirm email" so sign-up works live without an inbox.
4. **Keys** (Project Settings → API), all into `ai-server/.env` on the demo laptop:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only)
   - `SUPABASE_JWKS_URI` (`https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`). This project's tokens are ES256; without this (or `SUPABASE_JWT_SECRET`), the server fail-closes to stub storage.
   - The **anon** key goes in the Expo app's config. It's safe to ship.
5. Check the advisors: Database → Advisors (security and performance). These should come back clean except for the known `rls_auto_enable` helper.

## 3. Ollama (demo laptop)

```bash
ollama pull llama3.2          # or the model the team picks (PRD open question 6)
ollama serve                  # http://localhost:11434
```

Set `OLLAMA_MODEL` to match. A 7–8B model on a laptop GPU or Apple silicon takes about 10–40 s per recipe. Pre-generate recipes before the demo (step 7) so the live run is fast.

## 4. YouTube Data API (F4)

1. In Google Cloud Console, create a project, enable **YouTube Data API v3**, and create an **API key**. Restrict it to that API.
2. Put it in `ai-server/.env` as `YOUTUBE_API_KEY`.

The quota is 10,000 units/day, and a search costs 100, so that's about 100 searches/day. Results are cached per technique in `technique_videos`, and each recipe makes at most 6 new searches.

## 5. AI server (demo laptop)

```bash
cd ai-server
cp .env.example .env     # fill in steps 2–4
npm ci
npm run build
NODE_ENV=production HOST=0.0.0.0 npm start
```

- `NODE_ENV=production` refuses to start if a Supabase key is missing, and it forbids stub auth.
- `HOST=0.0.0.0` lets phones on the same Wi-Fi reach `http://<laptop-ip>:3001`.
- `curl http://localhost:3001/health` should return `{"status":"ok"}`.
- The startup log should show `Check-in route: ENABLED` and `Technique videos: ENABLED`.

## 6. Network: phones → AI server

Venue Wi-Fi often blocks device-to-device traffic, so plan on a tunnel:

```bash
cloudflared tunnel --url http://localhost:3001     # or: ngrok http 3001
```

Set `TRUST_PROXY=true` behind a tunnel so rate limiting sees real client IPs. Point the app's AI-server URL at the tunnel URL.

## 7. Before demo day

- [ ] Make a demo account, onboard it, and cook through all 10 slots once to pre-generate the recipes. Review every recipe for wrong steps and missing safety flags (PRD open question 6).
- [ ] Watch the cached video for each technique (`select * from technique_videos`). Fix any off-target video by updating its `video_id` (PRD open question 7).
- [ ] Run the XP reconcile job in case any award failed: `npm run reconcile:xp -- --dry-run`, then `npm run reconcile:xp`.
- [ ] Do a fresh-account dry run of the full loop on a phone over the tunnel (PRD success criterion 1).
- [ ] Do a run with Ollama stopped. Saved recipes should still load (PRD §6).
- [ ] Have a backup: a second demo account that has already reached slot 10, for the mastery challenge (success criterion 2).
