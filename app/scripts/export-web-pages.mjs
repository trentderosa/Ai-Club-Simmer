#!/usr/bin/env node
/**
 * Exports the web build for a GitHub Pages project site.
 * EXPO_BASE_URL sets the subpath (default /Ai-Club-Simmer). Then it copies
 * index.html to 404.html (single-page deep-link fallback) and adds .nojekyll
 * (Jekyll would drop the _expo/ folder).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const dist = join(appDir, 'dist');
const baseUrl = process.env.EXPO_BASE_URL || '/Ai-Club-Simmer';

const run = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, EXPO_BASE_URL: baseUrl },
});
if (run.status !== 0) process.exit(run.status ?? 1);

copyFileSync(join(dist, 'index.html'), join(dist, '404.html'));
writeFileSync(join(dist, '.nojekyll'), '');
console.log(`Pages build ready in dist/ (base path ${baseUrl}).`);
