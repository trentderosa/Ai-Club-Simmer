export interface Config {
  port: number;
  host: string;
  enablePreviewRoute: boolean;
  ollama: {
    baseUrl: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  supabase: {
    url?: string;
    serviceRoleKey?: string;
    jwtSecret?: string;
    jwksUri?: string;
  };
  xpAward: {
    timeoutMs: number;
  };
  youtube: {
    /** YouTube Data API v3 key (server only). Unset: recipes have no videos. */
    apiKey?: string;
    timeoutMs: number;
    /** Wall-clock budget for all of one recipe's searches together. */
    lookupBudgetMs: number;
  };
  /**
   * Browser origins allowed to call this server (Expo web). Echoed back as
   * Access-Control-Allow-Origin; never includes *.
   */
  allowedOrigins: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Parse an optional integer env var within [min, max]. Unset or empty uses the
 * default; anything else that is not a whole number in range throws, naming
 * only the variable and the allowed range.
 */
export function parseBoundedIntEnv(
  env: Env,
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export const XP_AWARD_TIMEOUT_MS = { default: 5000, min: 100, max: 60000 } as const;
export const YOUTUBE_TIMEOUT_MS = { default: 5000, min: 100, max: 60000 } as const;
export const VIDEO_LOOKUP_BUDGET_MS = { default: 8000, min: 100, max: 60000 } as const;

/**
 * Default CORS allowlist when ALLOWED_ORIGINS is unset or empty.
 * Expo SDK 58 (`expo start` and `expo start --web`) serves Metro and the web
 * app on port 8081. 19006 is the classic Expo webpack web port. localhost and
 * 127.0.0.1 are both listed because browsers treat them as different origins.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
];

/**
 * Parse ALLOWED_ORIGINS (comma-separated). Unset or empty uses the Expo
 * dev/web defaults. Entries must be origins (scheme + host, optional port,
 * no path). A wildcard is rejected so Access-Control-Allow-Origin is never *.
 */
export function parseAllowedOrigins(env: Env = process.env): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }
  const entries = raw
    .split(',')
    .map((part) => part.trim().replace(/\/+$/, ''))
    .filter((part) => part.length > 0);
  if (entries.some((entry) => entry === '*')) {
    throw new Error(
      'ALLOWED_ORIGINS must not include * (wildcard). List explicit origins instead.'
    );
  }
  if (entries.length === 0) {
    throw new Error(
      'ALLOWED_ORIGINS is set but contains no origins. List explicit origins, or unset it to use the defaults.'
    );
  }
  return entries.map((entry) => {
    const canonical = canonicalizeOrigin(entry);
    if (!canonical) {
      throw new Error(
        'ALLOWED_ORIGINS entries must be origins like http://localhost:8081 (scheme + host, optional port, no path)'
      );
    }
    return canonical;
  });
}

/**
 * Returns the origin in the form browsers send (default ports omitted), or
 * null if the value is not a scheme+host origin.
 */
function canonicalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.hostname.length === 0 ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    const canonical = `${url.protocol}//${url.host}`;
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    const withDefaultPort = url.port === '' ? `${url.protocol}//${url.hostname}:${defaultPort}` : canonical;
    if (value !== canonical && value !== withDefaultPort) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

export function loadYouTubeConfig(env: Env = process.env): Config['youtube'] {
  const apiKey = env.YOUTUBE_API_KEY?.trim();
  return {
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: parseBoundedIntEnv(
      env,
      'YOUTUBE_TIMEOUT_MS',
      YOUTUBE_TIMEOUT_MS.default,
      YOUTUBE_TIMEOUT_MS.min,
      YOUTUBE_TIMEOUT_MS.max
    ),
    lookupBudgetMs: parseBoundedIntEnv(
      env,
      'VIDEO_LOOKUP_BUDGET_MS',
      VIDEO_LOOKUP_BUDGET_MS.default,
      VIDEO_LOOKUP_BUDGET_MS.min,
      VIDEO_LOOKUP_BUDGET_MS.max
    ),
  };
}

export function loadXpAwardTimeoutMs(env: Env = process.env): number {
  return parseBoundedIntEnv(
    env,
    'XP_AWARD_TIMEOUT_MS',
    XP_AWARD_TIMEOUT_MS.default,
    XP_AWARD_TIMEOUT_MS.min,
    XP_AWARD_TIMEOUT_MS.max
  );
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3001', 10),
    // SECURITY: Default to localhost to prevent external access
    host: process.env.HOST || '127.0.0.1',
    // SECURITY: Preview route disabled by default (unauthenticated LLM access)
    enablePreviewRoute: process.env.ENABLE_PREVIEW_ROUTE === 'true',
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2',
      maxTokens: parseInt(process.env.OLLAMA_MAX_TOKENS || '1500', 10),
      timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10),
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10', 10),
    },
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: process.env.SUPABASE_JWT_SECRET,
      jwksUri: process.env.SUPABASE_JWKS_URI,
    },
    xpAward: {
      timeoutMs: loadXpAwardTimeoutMs(),
    },
    youtube: loadYouTubeConfig(),
    allowedOrigins: parseAllowedOrigins(),
  };
}

/**
 * Fail fast in production when required Supabase settings are missing.
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and one of
 * SUPABASE_JWT_SECRET / SUPABASE_JWKS_URI. Only variable names are reported,
 * never values. Dev and test keep the existing fallbacks (in-memory storage,
 * check-in route disabled without a JWT verifier).
 */
export function assertProductionConfig(supabase: Config['supabase']): void {
  const missing: string[] = [];
  if (!supabase.url) missing.push('SUPABASE_URL');
  if (!supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabase.jwtSecret && !supabase.jwksUri) {
    missing.push('SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required config for NODE_ENV=production: ${missing.join(', ')}. ` +
        'See ai-server/README.md (Production config).'
    );
  }
}

export const XP_RECONCILE_LOOKBACK_HOURS = { default: 168, min: 1, max: 720 } as const;
export const XP_RECONCILE_MIN_AGE_SECONDS = { default: 120, min: 0, max: 86400 } as const;
export const XP_RECONCILE_BATCH_LIMIT = { default: 100, min: 1, max: 1000 } as const;

export interface ReconcileConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
  lookbackHours: number;
  minAgeSeconds: number;
  batchLimit: number;
}

/**
 * Config for the XP reconcile job (npm run reconcile:xp). Needs the same
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as the server; errors name
 * variables only, never values.
 */
export function loadReconcileConfig(env: Env = process.env): ReconcileConfig {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing required config for XP reconcile: ${missing.join(', ')}`);
  }
  const bounded = (
    name: string,
    range: { default: number; min: number; max: number }
  ): number => parseBoundedIntEnv(env, name, range.default, range.min, range.max);

  return {
    url: env.SUPABASE_URL as string,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    timeoutMs: loadXpAwardTimeoutMs(env),
    lookbackHours: bounded('XP_RECONCILE_LOOKBACK_HOURS', XP_RECONCILE_LOOKBACK_HOURS),
    minAgeSeconds: bounded('XP_RECONCILE_MIN_AGE_SECONDS', XP_RECONCILE_MIN_AGE_SECONDS),
    batchLimit: bounded('XP_RECONCILE_BATCH_LIMIT', XP_RECONCILE_BATCH_LIMIT),
  };
}
