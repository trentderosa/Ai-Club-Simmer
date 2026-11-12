# Simmer AI Server

Local Node/TypeScript server that proxies recipe generation and Coach's notes to Ollama,
verifies Supabase user JWTs, saves check-ins, and awards XP.

## Development

```bash
cp .env.example .env   # fill in values; .env is gitignored
npm ci
npm run dev
npm run lint && npm run typecheck && npm test
```

Without Supabase settings, dev mode uses in-memory storage and check-ins return
`xp: { status: "skipped" }`.

## Production config

Set these in the server's environment (never in the repo, chat, or logs):

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. Server-side only. Used to save check-ins and call `award_slot_xp` |
| `SUPABASE_JWT_SECRET` **or** `SUPABASE_JWKS_URI` | Verifies user access tokens (HS256 secret or RS256 JWKS URL) |

With `NODE_ENV=production`, the server exits at startup and names any missing variable.

## XP on check-in

`POST /api/check-ins` saves the check-in, then calls `award_slot_xp(check_in_id)` over
PostgREST with the service-role key (`src/services/xp-awarder.ts`). The client never calls
`award_slot_xp`; since migration `20261112220000_lock_rpc_execute_grants.sql` only
`service_role` can execute it. The database applies the formula, the 50% repeat rule, the
100 XP/week repeat cap and `UNIQUE(check_in_id)`.

If the award fails, the check-in stays saved, the server logs `xp_award_failed` with the
`check_in_id` (no secrets), and the response carries `xp: { status: "failed" }`.
