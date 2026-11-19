#!/usr/bin/env node
/**
 * GitHub Pages guard. Mock mode (1 / true / all) builds with no backend.
 * Any other mode fails the build when the public Supabase URL, anon key, or
 * AI server URL is missing or not usable. Prints variable names only.
 *
 * The workflow sets EXPO_PUBLIC_MOCK_MODE to 1 when the repository variable
 * is unset, so an empty value here is live mode and fails closed.
 */
import { createRequire } from 'node:module';
import { configFromEnv, pagesConfigProblems } from '../src/api/config.ts';

const { scanLine } = createRequire(import.meta.url)('./secret-scan.cjs');

const cfg = configFromEnv({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_AI_SERVER_URL: process.env.EXPO_PUBLIC_AI_SERVER_URL,
  EXPO_PUBLIC_MOCK_MODE: process.env.EXPO_PUBLIC_MOCK_MODE,
  EXPO_PUBLIC_MOCK_XP_STATUS: process.env.EXPO_PUBLIC_MOCK_XP_STATUS,
});

const problems = pagesConfigProblems(cfg);
if (problems.length) {
  console.error(
    `::error::This Pages build needs usable public values for:${problems.map((name) => ` ${name}`).join('')}`,
  );
  process.exit(1);
}

if (cfg.supabaseAnonKey) {
  const hits = scanLine(cfg.supabaseAnonKey);
  if (hits.length) {
    console.error('::error::EXPO_PUBLIC_SUPABASE_ANON_KEY must be the public anon key. Server-only keys stay on the AI server.');
    process.exit(1);
  }
}

if (cfg.mockMode === 'all') {
  console.log('Mock mode: building with fake data and no backend.');
} else if (cfg.mockMode === 'ai') {
  console.log('Partial mock: real Supabase, fake AI server.');
} else {
  console.log('Live mode: Supabase URL, anon key, and AI server URL are set.');
}
