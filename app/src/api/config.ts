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

export const config: AppConfig = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  aiServerUrl: (process.env.EXPO_PUBLIC_AI_SERVER_URL ?? '').replace(/\/+$/, ''),
  mockMode: parseMockMode(process.env.EXPO_PUBLIC_MOCK_MODE),
  mockXpStatus: parseMockXpStatus(process.env.EXPO_PUBLIC_MOCK_XP_STATUS),
};

/** Names of env vars the current mode needs but doesn't have. */
export function missingConfig(c: AppConfig): string[] {
  const missing: string[] = [];
  if (c.mockMode !== 'all') {
    if (!c.supabaseUrl) missing.push('EXPO_PUBLIC_SUPABASE_URL');
    if (!c.supabaseAnonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  }
  if (c.mockMode === 'off' && !c.aiServerUrl) missing.push('EXPO_PUBLIC_AI_SERVER_URL');
  return missing;
}
