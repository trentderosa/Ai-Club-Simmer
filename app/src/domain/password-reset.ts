/**
 * Password reset (F1). Pure helpers for the redirect and the recovery callback.
 * Screens share the confirmation copy so mock mode cannot drift from live.
 */

export const PASSWORD_RESET_PATH = '/reset-password';

/** Same sentence on the live app and in practice mode. */
export const PASSWORD_RESET_SENT_COPY =
  'If an account uses that email, a link to set a new password is on its way. It can take a minute.';

/** Shown under the shared confirmation when the app is in full mock mode. */
export const PASSWORD_RESET_PRACTICE_COPY =
  'Practice mode: no email is sent to a real inbox. This is only the confirmation.';

/** AsyncStorage key. The value is the user id that still has to set a password. */
export const PASSWORD_RECOVERY_OWNER_KEY = 'simmer.password-recovery';

const SECRET_PARAMS = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'code', 'expires_in', 'expires_at', 'token_type'];

export interface RecoveryOwnerStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type AuthChange = 'signed_in' | 'signed_out' | 'password_recovery' | 'password_recovery_failed' | 'token_refresh' | 'other';

export type RecoveryLink =
  | { kind: 'none' }
  | { kind: 'error' }
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'code'; code: string };

export function mapAuthChange(event: string): AuthChange {
  switch (event) {
    case 'PASSWORD_RECOVERY':
      return 'password_recovery';
    case 'SIGNED_OUT':
      return 'signed_out';
    case 'TOKEN_REFRESHED':
      return 'token_refresh';
    case 'SIGNED_IN':
      return 'signed_in';
    default:
      return 'other';
  }
}

function combinedParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search);
  const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  hash.forEach((value, key) => params.set(key, value));
  return params;
}

function onResetPath(pathname: string): boolean {
  return /\/reset-password\/?$/.test(pathname);
}

/**
 * What a return link is asking the app to do.
 * A bare `type=recovery` is ignored. Tokens or a code are a real callback.
 * An error on that link is a failure, and must not update whatever session
 * was already on the device.
 */
export function parseRecoveryLink(href: string | null | undefined): RecoveryLink {
  if (!href) return { kind: 'none' };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'none' };
  }
  const params = combinedParams(url);
  const type = params.get('type');
  const recoveryShaped = type === 'recovery' || onResetPath(url.pathname);
  if (!recoveryShaped) return { kind: 'none' };
  if (params.has('error') || params.has('error_code') || params.has('error_description')) return { kind: 'error' };
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken };
  const code = params.get('code');
  if (code) return { kind: 'code', code };
  return { kind: 'none' };
}

/** Removes tokens and codes from a callback URL. The path and ordinary query stay. */
export function authCallbackUrlWithoutSecrets(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  for (const key of SECRET_PARAMS) url.searchParams.delete(key);
  const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  for (const key of SECRET_PARAMS) hash.delete(key);
  const hashText = hash.toString();
  url.hash = hashText ? `#${hashText}` : '';
  return url.toString();
}

/** Expo web base path (`/Ai-Club-Simmer` on Pages, empty locally). Drops anything that is not a path. */
export function normalizeBasePath(base: string | null | undefined): string {
  const trimmed = (base ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (trimmed.includes('://') || trimmed.startsWith('//') || /[\s?#]/.test(trimmed)) return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '');
}

/**
 * Prefer the base path baked in at build time. Otherwise use the document
 * `<base href>`, which the Pages export sets to the same path.
 */
export function resolveWebBasePath(configured: string | null | undefined, baseHref: string | null | undefined): string {
  const fromConfig = normalizeBasePath(configured);
  if (fromConfig) return fromConfig;
  if (!baseHref) return '';
  const trimmed = baseHref.trim();
  if (!trimmed) return '';
  try {
    const asUrl = trimmed.includes('://') ? new URL(trimmed) : new URL(trimmed, 'http://local.test');
    return normalizeBasePath(asUrl.pathname);
  } catch {
    return normalizeBasePath(trimmed);
  }
}

export interface AuthRedirectInput {
  platform: string;
  /** Current page URL. Web builds the redirect from its origin. */
  href?: string | null;
  /** Expo `experiments.baseUrl` or the document base path. */
  basePath?: string | null;
  /** `Linking.createURL('reset-password')` for iOS and Android. */
  nativeUrl: string;
}

/**
 * Where `resetPasswordForEmail` sends the user.
 * Web: current origin + Pages base path (or none, locally) + `/reset-password`.
 * Native: the app scheme URL.
 */
export function authRedirectTo(input: AuthRedirectInput): string {
  if (input.platform === 'web' && input.href) {
    try {
      const current = new URL(input.href);
      if (current.protocol === 'http:' || current.protocol === 'https:') {
        const base = normalizeBasePath(input.basePath);
        return `${current.origin}${base}${PASSWORD_RESET_PATH}`;
      }
    } catch {
      // Fall through to the native URL.
    }
  }
  return input.nativeUrl;
}

export async function readRecoveryOwner(storage: RecoveryOwnerStore | null): Promise<string | null> {
  if (!storage) return null;
  try {
    const value = (await storage.getItem(PASSWORD_RECOVERY_OWNER_KEY))?.trim() ?? '';
    return value || null;
  } catch {
    return null;
  }
}

export async function writeRecoveryOwner(storage: RecoveryOwnerStore | null, userId: string | null): Promise<void> {
  if (!storage) return;
  try {
    if (userId) await storage.setItem(PASSWORD_RECOVERY_OWNER_KEY, userId);
    else await storage.removeItem(PASSWORD_RECOVERY_OWNER_KEY);
  } catch {
    // Private mode, or a store that rejects writes. The in-memory flag still works for this visit.
  }
}
