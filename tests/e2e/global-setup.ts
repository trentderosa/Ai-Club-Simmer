/**
 * Runs once before the e2e files. Reads the local Supabase keys at runtime
 * (never printed, never written to disk), refuses to run against anything but
 * localhost, checks the AI server is up, and sweeps leftover test users when
 * the run ends.
 */
import { execFileSync } from 'node:child_process';
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
  if (!process.env.E2E_API_URL || !process.env.E2E_ANON_KEY || !process.env.E2E_SERVICE_KEY || !process.env.E2E_DB_URL) {
    loadFromSupabaseStatus();
  }
  process.env.E2E_AI_URL ??= 'http://127.0.0.1:3001';

  const apiUrl = process.env.E2E_API_URL ?? '';
  const dbUrl = process.env.E2E_DB_URL ?? '';
  const aiUrl = process.env.E2E_AI_URL;
  assertLocal('API_URL', apiUrl);
  assertLocal('DB_URL', dbUrl.replace(/^postgres(ql)?:/, 'http:'));
  assertLocal('E2E_AI_URL', aiUrl);
  if (!process.env.E2E_ANON_KEY || !process.env.E2E_SERVICE_KEY) {
    throw new Error('Missing Supabase keys');
  }

  const health = await fetch(`${aiUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`AI server is not answering at ${aiUrl}/health`);
  }

  return async () => {
    // Safety net: remove any e2e users a failed file left behind.
    const headers = {
      apikey: process.env.E2E_SERVICE_KEY ?? '',
      Authorization: `Bearer ${process.env.E2E_SERVICE_KEY ?? ''}`,
    };
    const res = await fetch(`${apiUrl}/auth/v1/admin/users?per_page=1000`, { headers });
    if (!res.ok) return;
    const body = (await res.json()) as { users?: Array<{ id: string; email?: string }> };
    for (const u of body.users ?? []) {
      if (u.email && /^e2e-[a-z0-9]+@simmer\.invalid$/.test(u.email)) {
        await fetch(`${apiUrl}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers });
      }
    }
  };
}
