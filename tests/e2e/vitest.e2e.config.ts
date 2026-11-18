import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real-account end-to-end suite. Needs local Supabase and the AI server running
 * (see "Real-account tests (local)" in the root README). Not part of `npm test`
 * and not run in CI. Files run one at a time because they share one AI server,
 * one Ollama and the server's per-IP rate limits.
 */
export default defineConfig({
  root: here,
  test: {
    globals: true,
    environment: 'node',
    include: ['scenarios/**/*.e2e.test.ts'],
    globalSetup: [path.join(here, 'global-setup.ts')],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
});
