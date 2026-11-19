/**
 * Runtime config, read from EXPO_PUBLIC_* env vars.
 *
 * Expo inlines these at build time, and only when they're read as literal
 * `process.env.EXPO_PUBLIC_NAME` expressions, so don't index process.env
 * dynamically here. Everything in this file ends up in the app bundle: only
 * public values (the Supabase URL and anon key) belong in it.
 */

/** `all`: fake everything. `ai`: real Supabase, fake ai-server. `off`: live. */
export type MockMode = 'off' | 'all' | 'ai';
export type MockXpStatus = 'awarded' | 'failed' | 'skipped';

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  aiServerUrl: string;
  mockMode: MockMode;
  mockXpStatus: MockXpStatus;
}

export function parseMockMode(raw: string | undefined): MockMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'all') return 'all';
  if (v === 'ai') return 'ai';
  return 'off';
}

export function parseMockXpStatus(raw: string | undefined): MockXpStatus {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'failed' || v === 'skipped' ? v : 'awarded';
}

export interface PublicEnv {
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  EXPO_PUBLIC_AI_SERVER_URL?: string;
  EXPO_PUBLIC_MOCK_MODE?: string;
  EXPO_PUBLIC_MOCK_XP_STATUS?: string;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Reads the public env. Callers must pass literal `process.env.EXPO_PUBLIC_*` reads so Expo can inline them. */
export function configFromEnv(env: PublicEnv): AppConfig {
  return {
    supabaseUrl: clean(env.EXPO_PUBLIC_SUPABASE_URL),
    supabaseAnonKey: clean(env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
    aiServerUrl: clean(env.EXPO_PUBLIC_AI_SERVER_URL).replace(/\/+$/, ''),
    mockMode: parseMockMode(env.EXPO_PUBLIC_MOCK_MODE),
    mockXpStatus: parseMockXpStatus(env.EXPO_PUBLIC_MOCK_XP_STATUS),
  };
}

export const config: AppConfig = configFromEnv({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_AI_SERVER_URL: process.env.EXPO_PUBLIC_AI_SERVER_URL,
  EXPO_PUBLIC_MOCK_MODE: process.env.EXPO_PUBLIC_MOCK_MODE,
  EXPO_PUBLIC_MOCK_XP_STATUS: process.env.EXPO_PUBLIC_MOCK_XP_STATUS,
});

/** Absolute http(s) URL with a host and no embedded user or password. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname) return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

function isPresentToken(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed);
}

/**
 * Names of env vars the current mode needs but doesn't have.
 * A blank, whitespace-only, or non-http(s) URL counts as missing, so the app
 * shows the setup screen instead of starting the live backend.
 */
export function missingConfig(c: AppConfig): string[] {
  const missing: string[] = [];
  if (c.mockMode !== 'all') {
    if (!isAbsoluteHttpUrl(c.supabaseUrl)) missing.push('EXPO_PUBLIC_SUPABASE_URL');
    if (!isPresentToken(c.supabaseAnonKey)) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  }
  if (c.mockMode === 'off' && !isAbsoluteHttpUrl(c.aiServerUrl)) missing.push('EXPO_PUBLIC_AI_SERVER_URL');
  return missing;
}

const EXAMPLE_SUPABASE_HOST = 'your-project-ref.supabase.co';
const EXAMPLE_ANON_KEY = 'your-anon-key';

/** Loopback hosts hit the visitor's own machine, so they are not a public backend. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4.slice(1).every((part) => Number(part) <= 255);
}

function isPublicSiteUrl(value: string): boolean {
  if (!isAbsoluteHttpUrl(value)) return false;
  const hostname = new URL(value.trim()).hostname;
  if (hostname.toLowerCase() === EXAMPLE_SUPABASE_HOST) return false;
  return !isLoopbackHost(hostname);
}

/**
 * Pages deploy check. Same requirements as `missingConfig`, plus the
 * `.env.example` placeholders and loopback hosts, which are not a public backend.
 * Full mock mode (`1` / `true` / `all`) needs nothing.
 */
export function pagesConfigProblems(c: AppConfig): string[] {
  const problems = missingConfig(c);
  if (c.mockMode === 'all') return problems;
  if (!problems.includes('EXPO_PUBLIC_SUPABASE_URL') && !isPublicSiteUrl(c.supabaseUrl)) {
    problems.push('EXPO_PUBLIC_SUPABASE_URL');
  }
  if (!problems.includes('EXPO_PUBLIC_SUPABASE_ANON_KEY') && c.supabaseAnonKey.trim().toLowerCase() === EXAMPLE_ANON_KEY) {
    problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  }
  if (c.mockMode === 'off' && !problems.includes('EXPO_PUBLIC_AI_SERVER_URL') && !isPublicSiteUrl(c.aiServerUrl)) {
    problems.push('EXPO_PUBLIC_AI_SERVER_URL');
  }
  return problems;
}
