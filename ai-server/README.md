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
| `XP_AWARD_TIMEOUT_MS` | Optional. Timeout for each `award_slot_xp` call (default `5000` ms, range `100`–`60000`). An invalid value stops startup |

With `NODE_ENV=production`, the server exits at startup and names any missing variable.

## XP on check-in

`POST /api/check-ins` saves the check-in, then calls `award_slot_xp(check_in_id)` over
PostgREST with the service-role key (`src/services/xp-awarder.ts`). The client never calls
`award_slot_xp`; since migration `20261112220000_lock_rpc_execute_grants.sql` only
`service_role` can execute it. The database applies the formula, the 50% repeat rule, the
100 XP/week repeat cap and `UNIQUE(check_in_id)`.

The call is aborted after `XP_AWARD_TIMEOUT_MS` (default 5000 ms).

If the award fails, the check-in stays saved, the server logs `xp_award_failed` with the
`check_in_id`, `slot_id` and a `reason` (`timeout`, `http`, `network`, `already_awarded`,
`invalid_response`, or `unknown`; no secrets), and the response carries `xp: { status: "failed" }`.
A timeout doesn't prove the award didn't happen: the database may have committed it after the
server stopped waiting. The reconcile job handles both cases.

## Reconcile missing XP awards

`src/jobs/reconcile-xp.ts` retries awards for check-ins that have no `xp_events` row.

```bash
npm run build
npm run reconcile:xp -- --dry-run   # list candidates only
npm run reconcile:xp                # award them
npm run reconcile:xp:dev            # same, via tsx without building
```

It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment (it doesn't read
`.env` itself; for example `node --env-file=.env dist/jobs/reconcile-xp.js`). Optional settings:

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `XP_RECONCILE_LOOKBACK_HOURS` | `168` | `1`–`720` | Only check-ins created in this many past hours |
| `XP_RECONCILE_MIN_AGE_SECONDS` | `120` | `0`–`86400` | Skip newer check-ins whose live award may still be running |
| `XP_RECONCILE_BATCH_LIMIT` | `100` | `1`–`1000` | Most check-ins per run (`batch_full: true` in the summary means run again) |
| `XP_AWARD_TIMEOUT_MS` | `5000` | `100`–`60000` | Timeout for the scan and for each award call |

How it works:

1. One PostgREST read, with the service role, of `check_ins` with no matching `xp_events` row
   (`select=id,slot_id,created_at,xp_events(id)&xp_events=is.null`), in the window, oldest
   first, up to the batch limit. It reads only ids, slot ids and timestamps. No migration was needed.
2. For each one, in order, it calls `award_slot_xp(check_in_id)`. The database still applies
   the formula, the 50% repeat rule and the 100 XP/week repeat cap.
3. If a check-in got its award in the meantime (another run, or a late live award),
   `UNIQUE(check_in_id)` rejects the second one (Postgres `23505`, HTTP 409). The job counts it
   as `skipped`, not failed. So repeated or concurrent runs never double-award.
4. It logs `xp_reconcile_awarded` / `xp_reconcile_award_failed` per check-in and one
   `xp_reconcile_summary` line with `scanned`, `awarded`, `skipped` and `failed`.

Exit code `0` means no failures, `1` means an award or the scan failed, and `2` means bad config or arguments.
Nothing schedules this job yet; run it by hand, or later from cron or a scheduler.

The weekly cap is computed for the week the award runs (UTC), so a repeat retried in a later
week counts toward that week's cap (PRD open question 10).
