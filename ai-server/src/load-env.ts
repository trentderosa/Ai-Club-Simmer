import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path to ai-server/.env, resolved from this file so it works from src/
 * or dist/ and does not depend on the process working directory.
 */
export function defaultEnvPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '.env');
}

/**
 * Parse a dotenv-style file into key/value pairs. Existing-process semantics
 * (override vs not) are applied by loadEnvFile, not here.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  const text = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Load KEY=VALUE pairs from a .env file into process.env when the file exists.
 * Already-set variables are left unchanged so CI, tests, and the shell win.
 * A missing file is a no-op — CI and tests must not require .env.
 */
export function loadEnvFile(envPath: string = defaultEnvPath()): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }

  const parsed = parseEnvFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}
