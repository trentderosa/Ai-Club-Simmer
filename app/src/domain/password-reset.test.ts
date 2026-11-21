import { ApiError } from '../api/errors';
import { errorCopy } from './error-messages';
import {
  PASSWORD_RESET_EMAIL_LIMIT_COPY,
  PASSWORD_RESET_PRACTICE_COPY,
  PASSWORD_RESET_SENT_COPY,
  authCallbackUrlWithoutSecrets,
  authRedirectTo,
  isPasswordResetEmail,
  mapAuthChange,
  parseRecoveryLink,
  readRecoveryOwner,
  recoverySessionMatchesLink,
  resolveWebBasePath,
  writeRecoveryOwner,
  type RecoveryOwnerStore,
} from './password-reset';

function memoryStorage(): RecoveryOwnerStore {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

describe('password reset redirect', () => {
  const nativeUrl = 'simmer://reset-password';

  it('uses the GitHub Pages base path', () => {
    expect(
      authRedirectTo({
        platform: 'web',
        href: 'https://trentderosa.github.io/Ai-Club-Simmer/sign-in',
        basePath: '/Ai-Club-Simmer',
        nativeUrl,
      }),
    ).toBe('https://trentderosa.github.io/Ai-Club-Simmer/reset-password');
  });

  it('uses the local origin when there is no base path', () => {
    expect(
      authRedirectTo({
        platform: 'web',
        href: 'http://localhost:8081/sign-in?x=1#hash',
        basePath: '',
        nativeUrl,
      }),
    ).toBe('http://localhost:8081/reset-password');
  });

  it('drops a trailing slash and ignores the current query', () => {
    expect(
      authRedirectTo({
        platform: 'web',
        href: 'http://127.0.0.1:19006/forgot-password?email=a@b.c',
        basePath: '/Ai-Club-Simmer/',
        nativeUrl,
      }),
    ).toBe('http://127.0.0.1:19006/Ai-Club-Simmer/reset-password');
  });

  it('ignores a base path that is not a path', () => {
    expect(
      authRedirectTo({
        platform: 'web',
        href: 'https://trentderosa.github.io/sign-in',
        basePath: 'https://evil.example/phish',
        nativeUrl,
      }),
    ).toBe('https://trentderosa.github.io/reset-password');
  });

  it('uses the app scheme off the web', () => {
    expect(
      authRedirectTo({
        platform: 'ios',
        href: 'http://localhost:8081/',
        basePath: '/Ai-Club-Simmer',
        nativeUrl,
      }),
    ).toBe(nativeUrl);
  });
});

describe('web base path', () => {
  it('prefers the configured Pages path over the document base', () => {
    expect(resolveWebBasePath('/Ai-Club-Simmer', '/other/')).toBe('/Ai-Club-Simmer');
  });

  it('reads a root-relative or absolute base href', () => {
    expect(resolveWebBasePath('', '/Ai-Club-Simmer/')).toBe('/Ai-Club-Simmer');
    expect(resolveWebBasePath(null, 'https://trentderosa.github.io/Ai-Club-Simmer/')).toBe('/Ai-Club-Simmer');
  });

  it('is empty for local web', () => {
    expect(resolveWebBasePath(undefined, '/')).toBe('');
    expect(resolveWebBasePath(undefined, null)).toBe('');
  });
});

describe('recovery callback', () => {
  it('reads tokens or a code only when the link is a reset', () => {
    expect(parseRecoveryLink('https://trentderosa.github.io/Ai-Club-Simmer/#access_token=abc&refresh_token=def&type=recovery')).toEqual({
      kind: 'tokens',
      accessToken: 'abc',
      refreshToken: 'def',
    });
    expect(parseRecoveryLink('http://localhost:8081/reset-password?code=abc')).toEqual({ kind: 'code', code: 'abc' });
    expect(parseRecoveryLink('http://localhost:8081/Ai-Club-Simmer/reset-password?type=recovery&code=abc')).toEqual({ kind: 'code', code: 'abc' });
  });

  it('treats an error on the link as a failure, not a session to update', () => {
    expect(parseRecoveryLink('http://localhost:8081/reset-password#error=access_denied&error_code=otp_expired')).toEqual({ kind: 'error' });
    expect(parseRecoveryLink('https://trentderosa.github.io/Ai-Club-Simmer/#error=access_denied&type=recovery')).toEqual({ kind: 'error' });
    // Dev and standalone builds put the route in the host. Pages and Expo Go use a path.
    expect(parseRecoveryLink('simmer://reset-password#error=access_denied&error_code=otp_expired')).toEqual({ kind: 'error' });
  });

  it('ignores a bare type, a plain visit, and other auth types', () => {
    expect(parseRecoveryLink('http://localhost:8081/?type=recovery')).toEqual({ kind: 'none' });
    expect(parseRecoveryLink('http://localhost:8081/reset-password')).toEqual({ kind: 'none' });
    expect(parseRecoveryLink('http://localhost:8081/#access_token=abc&refresh_token=def&type=signup')).toEqual({ kind: 'none' });
    expect(parseRecoveryLink('not a url')).toEqual({ kind: 'none' });
    expect(parseRecoveryLink(null)).toEqual({ kind: 'none' });
  });

  it('strips tokens and codes from the address bar', () => {
    const cleaned = authCallbackUrlWithoutSecrets(
      'http://localhost:8081/Ai-Club-Simmer/reset-password?code=abc&type=recovery#access_token=secret&refresh_token=other&type=recovery',
    );
    expect(cleaned).not.toContain('abc');
    expect(cleaned).not.toContain('secret');
    expect(cleaned).not.toContain('other');
    expect(cleaned).toContain('/Ai-Club-Simmer/reset-password');
    expect(cleaned).toContain('type=recovery');
  });

  it('maps the recovery auth event', () => {
    expect(mapAuthChange('PASSWORD_RECOVERY')).toBe('password_recovery');
    expect(mapAuthChange('TOKEN_REFRESHED')).toBe('token_refresh');
    expect(mapAuthChange('INITIAL_SESSION')).toBe('other');
  });
});

describe('recovery owner', () => {
  it('remembers who still has to set a password', async () => {
    const storage = memoryStorage();
    expect(await readRecoveryOwner(storage)).toBeNull();
    await writeRecoveryOwner(storage, 'user-1');
    expect(await readRecoveryOwner(storage)).toBe('user-1');
    await writeRecoveryOwner(storage, null);
    expect(await readRecoveryOwner(storage)).toBeNull();
  });

  it('survives a store that throws', async () => {
    const storage: RecoveryOwnerStore = {
      getItem: async () => {
        throw new Error('blocked');
      },
      setItem: async () => {
        throw new Error('blocked');
      },
      removeItem: async () => {
        throw new Error('blocked');
      },
    };
    expect(await readRecoveryOwner(storage)).toBeNull();
    await expect(writeRecoveryOwner(storage, 'user-1')).resolves.toBeUndefined();
    expect(await readRecoveryOwner(null)).toBeNull();
  });
});

describe('password reset copy', () => {
  it('uses one confirmation, and practice mode does not claim a real email', () => {
    expect(PASSWORD_RESET_SENT_COPY).toMatch(/If an account uses that email/);
    expect(PASSWORD_RESET_PRACTICE_COPY).toMatch(/Practice mode/);
    expect(PASSWORD_RESET_PRACTICE_COPY).toMatch(/no email is sent/);
    expect(PASSWORD_RESET_PRACTICE_COPY).not.toMatch(/real inbox was sent|email was sent to/i);
  });

  it('tells a reset-email limit to wait an hour', () => {
    expect(PASSWORD_RESET_EMAIL_LIMIT_COPY).toMatch(/Too many emails were sent/);
    expect(PASSWORD_RESET_EMAIL_LIMIT_COPY).toMatch(/in an hour/);
    const copy = errorCopy(new ApiError('rate_limited', 'raw', 429, 'email_rate_limited'));
    expect(copy.body).toBe(PASSWORD_RESET_EMAIL_LIMIT_COPY);
    expect(errorCopy(new ApiError('rate_limited', 'Too many requests', 429)).body).toMatch(/Wait a minute/);
  });
});

describe('password reset email check', () => {
  it('matches the forgot-password screen and mock mode', () => {
    expect(isPasswordResetEmail('person@simmer.test')).toBe(true);
    expect(isPasswordResetEmail('  person@simmer.test  ')).toBe(true);
    expect(isPasswordResetEmail('a@b')).toBe(false);
    expect(isPasswordResetEmail('not-an-email')).toBe(false);
  });

  it('accepts a web session only when its access token is the link token', () => {
    const link = parseRecoveryLink('http://localhost:8081/reset-password#access_token=from-the-link&refresh_token=r&type=recovery');
    expect(recoverySessionMatchesLink(link, 'from-the-link')).toBe(true);
    expect(recoverySessionMatchesLink(link, 'already-signed-in')).toBe(false);
    expect(recoverySessionMatchesLink({ kind: 'code', code: 'abc' }, 'abc')).toBe(false);
    expect(recoverySessionMatchesLink({ kind: 'error' }, 'from-the-link')).toBe(false);
  });
});
