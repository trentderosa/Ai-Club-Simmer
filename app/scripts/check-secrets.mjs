#!/usr/bin/env node
/**
 * Fails if app/ (outside node_modules and build output) contains anything
 * that looks like the Supabase service-role key or a reference to it:
 *  - the words "service_role" / "SERVICE_ROLE" / "serviceRole" in code or config
 *  - a JWT whose payload has role "service_role"
 *  - a new-style Supabase secret key (sb_secret_...)
 * The app may only use the anon key. Markdown docs, eslint.config.js (which
 * holds the matching lint rule) and this script are allowed to name it.
 *
 * `--dir dist` scans a built output folder instead (every text file, no
 * allow list). Matched values are never printed, only paths and the kind.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { scanDir } = createRequire(import.meta.url)('./secret-scan.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const dirFlag = process.argv.indexOf('--dir');

if (dirFlag !== -1) {
  const arg = process.argv[dirFlag + 1];
  if (!arg) {
    console.error('Usage: check-secrets.mjs [--dir <built output folder>]');
    process.exit(2);
  }
  const dir = resolve(process.cwd(), arg);
  if (!existsSync(dir)) {
    console.error(`Build output folder not found: ${arg}`);
    process.exit(2);
  }
  const hits = scanDir(dir, { text: /\.(html|js|mjs|cjs|json|map|css|txt|xml|webmanifest)$/ });
  if (hits.length) {
    console.error('Server-only Supabase credentials found in the built output:');
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`OK: no service-role key or references in ${arg}.`);
  process.exit(0);
}

const hits = scanDir(root, {
  root,
  skipDirs: new Set(['node_modules', '.expo', 'dist', 'web-build', 'ios', 'android', '.git', 'coverage']),
  allow: new Set(['scripts/check-secrets.mjs', 'scripts/secret-scan.cjs', 'eslint.config.js']),
  text: /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml)$|^\.env/,
});

if (hits.length) {
  console.error('Server-only Supabase credentials referenced in app/ (the app may only use the anon key):');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('OK: no service-role key or references in app/.');
