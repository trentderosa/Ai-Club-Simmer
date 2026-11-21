import { describe, it, expect } from 'vitest';
import { assertProductionConfig, assertProductionTunnelHost, DEFAULT_ALLOWED_ORIGINS, isLoopbackBindHost, loadCookAnythingConfig, loadDishPhotoConfig, loadXpAwardTimeoutMs, loadYouTubeConfig, parseAllowedOrigins, parseBoundedIntEnv, PRODUCTION_LOOPBACK_TUNNEL_MESSAGE } from './config.js';

const full = {
  url: 'https://example.supabase.co',
  serviceRoleKey: 'placeholder-key-value',
  jwtSecret: 'placeholder-jwt-secret',
};

describe('assertProductionConfig', () => {
  it('passes with URL, service-role key and a JWT setting', () => {
    expect(() => assertProductionConfig(full)).not.toThrow();
    expect(() =>
      assertProductionConfig({ ...full, jwtSecret: undefined, jwksUri: 'https://example/jwks' })
    ).not.toThrow();
  });

  it('names every missing variable', () => {
    expect(() => assertProductionConfig({})).toThrow(
      /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI/
    );
  });

  it('names a missing service-role key without echoing other values', () => {
    let message = '';
    try {
      assertProductionConfig({ ...full, serviceRoleKey: undefined });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(message).not.toContain('SUPABASE_URL,');
    expect(message).not.toContain(full.jwtSecret);
  });
});

describe('assertProductionTunnelHost', () => {
  it('refuses production when HOST is loopback and TRUST_PROXY is true', () => {
    const env = {
      NODE_ENV: 'production',
      TRUST_PROXY: 'true',
      SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role',
    };
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2', '127.1', ' 127.0.0.1 ']) {
      expect(() => assertProductionTunnelHost(env, host)).toThrow(PRODUCTION_LOOPBACK_TUNNEL_MESSAGE);
    }
    let message = '';
    try {
      assertProductionTunnelHost(env, '127.0.0.1');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('HOST=0.0.0.0');
    expect(message).not.toContain('placeholder-service-role');
  });

  it('allows a non-loopback HOST with TRUST_PROXY in production', () => {
    const env = { NODE_ENV: 'production', TRUST_PROXY: 'true' };
    expect(() => assertProductionTunnelHost(env, '0.0.0.0')).not.toThrow();
    expect(() => assertProductionTunnelHost(env, '::')).not.toThrow();
    expect(() => assertProductionTunnelHost(env, '192.168.1.20')).not.toThrow();
  });

  it('allows loopback when TRUST_PROXY is unset, including in production', () => {
    expect(() => assertProductionTunnelHost({ NODE_ENV: 'production' }, '127.0.0.1')).not.toThrow();
    expect(() =>
      assertProductionTunnelHost({ NODE_ENV: 'production', TRUST_PROXY: 'false' }, 'localhost')
    ).not.toThrow();
    expect(() => assertProductionTunnelHost({ NODE_ENV: 'test', TRUST_PROXY: 'true' }, '127.0.0.1')).not.toThrow();
    expect(() => assertProductionTunnelHost({ TRUST_PROXY: 'true' }, '127.0.0.1')).not.toThrow();
  });
});

describe('isLoopbackBindHost', () => {
  it('recognizes loopback binds and leaves other addresses alone', () => {
    for (const host of [
      '127.0.0.1',
      '127.1',
      '127.0.1',
      'localhost',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(isLoopbackBindHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.2', '', 'example.com']) {
      expect(isLoopbackBindHost(host)).toBe(false);
    }
  });
});

describe('XP_AWARD_TIMEOUT_MS', () => {
  it('defaults to 5000 when unset or empty', () => {
    expect(loadXpAwardTimeoutMs({})).toBe(5000);
    expect(loadXpAwardTimeoutMs({ XP_AWARD_TIMEOUT_MS: '' })).toBe(5000);
  });

  it('accepts whole numbers from 100 to 60000', () => {
    expect(loadXpAwardTimeoutMs({ XP_AWARD_TIMEOUT_MS: '100' })).toBe(100);
    expect(loadXpAwardTimeoutMs({ XP_AWARD_TIMEOUT_MS: ' 2500 ' })).toBe(2500);
    expect(loadXpAwardTimeoutMs({ XP_AWARD_TIMEOUT_MS: '60000' })).toBe(60000);
  });

  it.each(['0', '99', '60001', '-5', '1.5', '5s', 'abc', '1e4'])('rejects %j', (raw) => {
    expect(() => loadXpAwardTimeoutMs({ XP_AWARD_TIMEOUT_MS: raw })).toThrow(
      'XP_AWARD_TIMEOUT_MS must be a whole number from 100 to 60000'
    );
  });
});

describe('parseBoundedIntEnv', () => {
  it('does not echo the bad value in the error', () => {
    expect(() => parseBoundedIntEnv({ X: 'secret-ish' }, 'X', 1, 0, 10)).toThrow(
      /^X must be a whole number from 0 to 10$/
    );
  });
});

describe('loadYouTubeConfig', () => {
  it('no key: videos disabled, default timeout', () => {
    expect(loadYouTubeConfig({})).toEqual({ timeoutMs: 5000, lookupBudgetMs: 8000 });
    expect(loadYouTubeConfig({ YOUTUBE_API_KEY: '   ' })).toEqual({ timeoutMs: 5000, lookupBudgetMs: 8000 });
  });

  it('reads the key and a bounded timeout', () => {
    expect(loadYouTubeConfig({ YOUTUBE_API_KEY: 'placeholder-key', YOUTUBE_TIMEOUT_MS: '2500' })).toEqual({
      apiKey: 'placeholder-key',
      timeoutMs: 2500,
      lookupBudgetMs: 8000,
    });
  });

  it('rejects an out-of-range timeout, naming only the variable', () => {
    expect(() => loadYouTubeConfig({ YOUTUBE_API_KEY: 'placeholder-key', YOUTUBE_TIMEOUT_MS: '0' })).toThrow(
      'YOUTUBE_TIMEOUT_MS must be a whole number from 100 to 60000'
    );
  });

  it('reads a bounded VIDEO_LOOKUP_BUDGET_MS and rejects bad values at startup', () => {
    expect(loadYouTubeConfig({ VIDEO_LOOKUP_BUDGET_MS: '3000' }).lookupBudgetMs).toBe(3000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5', '-5']) {
      expect(() => loadYouTubeConfig({ VIDEO_LOOKUP_BUDGET_MS: bad })).toThrow(
        'VIDEO_LOOKUP_BUDGET_MS must be a whole number from 100 to 60000'
      );
    }
  });
});

describe('parseAllowedOrigins', () => {
  it('defaults to the Expo dev and web origins when unset or empty', () => {
    expect(parseAllowedOrigins({})).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(parseAllowedOrigins({ ALLOWED_ORIGINS: '' })).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(parseAllowedOrigins({ ALLOWED_ORIGINS: '   ' })).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect(DEFAULT_ALLOWED_ORIGINS).toEqual([
      'http://localhost:8081',
      'http://127.0.0.1:8081',
      'http://localhost:19006',
      'http://127.0.0.1:19006',
    ]);
  });

  it('parses a comma-separated list, trimming whitespace and trailing slashes', () => {
    expect(
      parseAllowedOrigins({
        ALLOWED_ORIGINS: ' https://app.example:443/, http://localhost:8081 ',
      })
    ).toEqual(['https://app.example', 'http://localhost:8081']);
  });

  it('rejects a wildcard without echoing the value', () => {
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: '*' })).toThrow(
      'ALLOWED_ORIGINS must not include * (wildcard). List explicit origins instead.'
    );
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: 'http://localhost:8081, *' })).toThrow(
      'ALLOWED_ORIGINS must not include * (wildcard). List explicit origins instead.'
    );
  });

  it('rejects entries that are not origins, without echoing them', () => {
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: 'localhost:8081' })).toThrow(
      'ALLOWED_ORIGINS entries must be origins like http://localhost:8081 (scheme + host, optional port, no path)'
    );
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: 'http://localhost:8081/app' })).toThrow(
      'ALLOWED_ORIGINS entries must be origins like http://localhost:8081 (scheme + host, optional port, no path)'
    );
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: 'ftp://localhost' })).toThrow(
      'ALLOWED_ORIGINS entries must be origins like http://localhost:8081 (scheme + host, optional port, no path)'
    );
  });

  it('accepts the GitHub Pages origin and rejects a path on that host', () => {
    expect(
      parseAllowedOrigins({
        ALLOWED_ORIGINS:
          'http://localhost:8081, https://trentderosa.github.io/',
      })
    ).toEqual(['http://localhost:8081', 'https://trentderosa.github.io']);
    expect(() =>
      parseAllowedOrigins({
        ALLOWED_ORIGINS: 'https://trentderosa.github.io/Ai-Club-Simmer',
      })
    ).toThrow(
      'ALLOWED_ORIGINS entries must be origins like http://localhost:8081 (scheme + host, optional port, no path)'
    );
  });

  it('rejects a list that has no origins after trimming', () => {
    expect(() => parseAllowedOrigins({ ALLOWED_ORIGINS: ' , , ' })).toThrow(
      'ALLOWED_ORIGINS is set but contains no origins. List explicit origins, or unset it to use the defaults.'
    );
  });
});

describe('loadCookAnythingConfig', () => {
  it('defaults to 80 characters and 5 uncached generations per hour', () => {
    expect(loadCookAnythingConfig({})).toEqual({
      maxDishLength: 80,
      generationRateLimit: { windowMs: 3_600_000, maxGenerations: 5 },
    });
  });

  it('reads bounded overrides', () => {
    expect(
      loadCookAnythingConfig({
        COOK_ANYTHING_MAX_DISH_LENGTH: '120',
        COOK_ANYTHING_RATE_LIMIT_WINDOW_MS: '60000',
        COOK_ANYTHING_RATE_LIMIT_MAX: '2',
      })
    ).toEqual({
      maxDishLength: 120,
      generationRateLimit: { windowMs: 60_000, maxGenerations: 2 },
    });
  });

  it('rejects an out-of-range max length, naming only the variable', () => {
    expect(() => loadCookAnythingConfig({ COOK_ANYTHING_MAX_DISH_LENGTH: '9' })).toThrow(
      /COOK_ANYTHING_MAX_DISH_LENGTH/
    );
    expect(() => loadCookAnythingConfig({ COOK_ANYTHING_MAX_DISH_LENGTH: '9' })).not.toThrow(/9/);
  });
});

describe('loadDishPhotoConfig', () => {
  it('uses the default timeout when unset', () => {
    expect(loadDishPhotoConfig({})).toEqual({ timeoutMs: 2500 });
  });

  it('reads a bounded timeout and rejects bad values at startup', () => {
    expect(loadDishPhotoConfig({ DISH_PHOTO_LOOKUP_TIMEOUT_MS: '3000' }).timeoutMs).toBe(3000);
    for (const bad of ['0', '499', '10001', 'abc', '1.5']) {
      expect(() => loadDishPhotoConfig({ DISH_PHOTO_LOOKUP_TIMEOUT_MS: bad })).toThrow(
        'DISH_PHOTO_LOOKUP_TIMEOUT_MS must be a whole number from 500 to 10000'
      );
    }
  });
});
