/**
 * Runs once before the e2e files. Reads the local Supabase keys at runtime
 * (never printed, never written to disk), refuses to run against anything but
 * localhost, checks the AI server is up, and sweeps leftover test users when
 * the run ends.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function assertLocal(name: string, value: string): void {
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run: ${name} must point at 127.0.0.1 or localhost`);
  }
}

function loadFromSupabaseStatus(): void {
  let raw: string;
  try {
    raw = execFileSync('npx', ['-y', 'supabase@3.2.0', 'status', '-o', 'json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    throw new Error('Could not run `supabase status`. Is local Supabase running (supabase start)?');
  }
  let status: Record<string, string>;
  try {
    status = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error('`supabase status -o json` did not return JSON');
  }
  process.env.E2E_API_URL = status.API_URL;
  process.env.E2E_ANON_KEY = status.ANON_KEY;
  process.env.E2E_SERVICE_KEY = status.SERVICE_ROLE_KEY;
  process.env.E2E_DB_URL = status.DB_URL;
}

export default async function setup(): Promise<() => Promise<void>> {
  // Per-run id so overlapping runs only clean up their own users.
  const runId = randomBytes(4).toString('hex');
  process.env.E2E_RUN_ID = runId;
  if (!process.env.E2E_API_URL || !process.env.E2E_ANON_KEY || !process.env.E2E_SERVICE_KEY || !process.env.E2E_DB_URL) {
    loadFromSupabaseStatus();
  }
  process.env.E2E_AI_URL ??= 'http://127.0.0.1:3001';

  const apiUrl = process.env.E2E_API_URL ?? '';
  const dbUrl = process.env.E2E_DB_URL ?? '';
  const aiUrl = process.env.E2E_AI_URL;
  assertLocal('API_URL', apiUrl);
  assertLocal('DB_URL', dbUrl.replace(/^postgres(ql)?:/, 'http:'));
  const dbParams = new URL(dbUrl.replace(/^postgres(ql)?:/, 'http:')).searchParams;
  if (dbParams.has('host') || dbParams.has('hostaddr')) {
    throw new Error('Refusing to run: DB_URL must not use host or hostaddr query parameters');
  }
  assertLocal('E2E_AI_URL', aiUrl);
  if (!process.env.E2E_ANON_KEY || !process.env.E2E_SERVICE_KEY) {
    throw new Error('Missing Supabase keys');
  }

  const health = await fetch(`${aiUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`AI server is not answering at ${aiUrl}/health`);
  }

  return async () => {
    // Safety net: remove this run's e2e users a failed file left behind.
    const headers = {
      apikey: process.env.E2E_SERVICE_KEY ?? '',
      Authorization: `Bearer ${process.env.E2E_SERVICE_KEY ?? ''}`,
    };
    const mine = new RegExp(`^e2e-${runId}-[a-z0-9]+@simmer\\.invalid$`);
    // Collect first, delete after, so deleting does not shift the pages.
    const ids: string[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const res = await fetch(`${apiUrl}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
      if (!res.ok) break;
      const body = (await res.json()) as { users?: Array<{ id: string; email?: string }> };
      const users = body.users ?? [];
      for (const u of users) {
        if (u.email && mine.test(u.email)) ids.push(u.id);
      }
      if (users.length < 200) break;
    }
    for (const id of ids) {
      await fetch(`${apiUrl}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers });
    }
  };
}
