#!/usr/bin/env node
/**
 * Fails if app/ (outside node_modules and build output) contains anything
 * that looks like the Supabase service-role key or a reference to it:
 *  - the words "service_role" / "SERVICE_ROLE" / "serviceRole" in code or config
 *  - a JWT whose payload has role "service_role"
 *  - a new-style Supabase secret key (sb_secret_...)
 * The app may only use the anon key. Markdown docs, eslint.config.js (which
 * holds the matching lint rule) and this script are allowed to name it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.expo', 'dist', 'web-build', 'ios', 'android', '.git', 'coverage']);
const ALLOW = new Set(['scripts/check-secrets.mjs', 'eslint.config.js']);
const NAME = /service[_\s-]?role|serviceRole/i;
const JWT = /eyJ[\w-]{10,}\.([\w-]{10,})\.[\w-]{10,}/g;
const SECRET_KEY = /\bsb_secret_[\w-]{8,}/;
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml)$|^\.env/;

function jwtRole(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
      continue;
    }
    if (!TEXT.test(name)) continue;
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const where = `${rel}:${i + 1}`;
        if (!ALLOW.has(rel) && NAME.test(line)) hits.push(`${where}: mentions the service role`);
        if (SECRET_KEY.test(line)) hits.push(`${where}: looks like a Supabase secret key`);
        for (const m of line.matchAll(JWT)) {
          if (jwtRole(m[1]) === 'service_role') hits.push(`${where}: JWT with role service_role`);
        }
      });
  }
}
walk(root);

if (hits.length) {
  console.error('Server-only Supabase credentials referenced in app/ (the app may only use the anon key):');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('OK: no service-role key or references in app/.');
