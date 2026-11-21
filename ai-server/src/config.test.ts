import { describe, it, expect } from 'vitest';
import { assertProductionConfig, DEFAULT_ALLOWED_ORIGINS, loadCookAnythingConfig, loadDishPhotoConfig, loadOllamaGateConfig, loadXpAwardTimeoutMs, isRecipePrewarmEnabled, ollamaTimingWarnings, loadYouTubeConfig, parseAllowedOrigins, parseBoundedIntEnv } from './config.js';

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

describe('loadOllamaGateConfig', () => {
  it('defaults to one call at a time, 3 waiting, 60s and 15s waits, and the request budgets', () => {
    expect(loadOllamaGateConfig({})).toEqual({
      maxConcurrent: 1,
      maxQueue: 3,
      queueTimeoutMs: 60000,
      coachNoteQueueTimeoutMs: 15000,
      requestBudgetMs: 170000,
      coachNoteBudgetMs: 120000,
    });
  });

  it('reads overrides, including a queue of 0', () => {
    expect(
      loadOllamaGateConfig({
        OLLAMA_MAX_CONCURRENT: '2',
        OLLAMA_MAX_QUEUE: '0',
        OLLAMA_QUEUE_TIMEOUT_MS: '5000',
        OLLAMA_COACH_NOTE_QUEUE_TIMEOUT_MS: '2000',
        OLLAMA_REQUEST_BUDGET_MS: '10000',
        OLLAMA_COACH_NOTE_BUDGET_MS: '600000',
      })
    ).toEqual({
      maxConcurrent: 2,
      maxQueue: 0,
      queueTimeoutMs: 5000,
      coachNoteQueueTimeoutMs: 2000,
      requestBudgetMs: 10000,
      coachNoteBudgetMs: 600000,
    });
  });

  it('rejects out-of-range or non-numeric values, naming the variable', () => {
    expect(() => loadOllamaGateConfig({ OLLAMA_MAX_CONCURRENT: '0' })).toThrow(/OLLAMA_MAX_CONCURRENT/);
    expect(() => loadOllamaGateConfig({ OLLAMA_MAX_CONCURRENT: '9' })).toThrow(/OLLAMA_MAX_CONCURRENT/);
    expect(() => loadOllamaGateConfig({ OLLAMA_MAX_QUEUE: '101' })).toThrow(/OLLAMA_MAX_QUEUE/);
    expect(() => loadOllamaGateConfig({ OLLAMA_MAX_QUEUE: '-1' })).toThrow(/OLLAMA_MAX_QUEUE/);
    expect(() => loadOllamaGateConfig({ OLLAMA_QUEUE_TIMEOUT_MS: '999' })).toThrow(/OLLAMA_QUEUE_TIMEOUT_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_QUEUE_TIMEOUT_MS: '600001' })).toThrow(/OLLAMA_QUEUE_TIMEOUT_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_COACH_NOTE_QUEUE_TIMEOUT_MS: 'abc' })).toThrow(
      /OLLAMA_COACH_NOTE_QUEUE_TIMEOUT_MS/
    );
    expect(() => loadOllamaGateConfig({ OLLAMA_REQUEST_BUDGET_MS: '9999' })).toThrow(/OLLAMA_REQUEST_BUDGET_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_REQUEST_BUDGET_MS: '600001' })).toThrow(/OLLAMA_REQUEST_BUDGET_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_COACH_NOTE_BUDGET_MS: '4999' })).toThrow(/OLLAMA_COACH_NOTE_BUDGET_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_COACH_NOTE_BUDGET_MS: '600001' })).toThrow(/OLLAMA_COACH_NOTE_BUDGET_MS/);
    expect(() => loadOllamaGateConfig({ OLLAMA_COACH_NOTE_BUDGET_MS: 'abc' })).toThrow(/OLLAMA_COACH_NOTE_BUDGET_MS/);
  });
});

describe('isRecipePrewarmEnabled', () => {
  it('is on by default and for unknown values', () => {
    expect(isRecipePrewarmEnabled({})).toBe(true);
    expect(isRecipePrewarmEnabled({ RECIPE_PREWARM: '' })).toBe(true);
    expect(isRecipePrewarmEnabled({ RECIPE_PREWARM: 'true' })).toBe(true);
  });

  it('turns off for false, 0 and off in any case', () => {
    for (const value of ['false', 'FALSE', '0', 'off', ' Off ']) {
      expect(isRecipePrewarmEnabled({ RECIPE_PREWARM: value })).toBe(false);
    }
  });
});

describe('ollamaTimingWarnings', () => {
  it('returns nothing when both budgets exceed the timeout', () => {
    expect(ollamaTimingWarnings(60000, 170000, 120000)).toEqual([]);
  });

  it('warns for each budget that is not strictly greater, naming the values', () => {
    const w = ollamaTimingWarnings(120000, 120000, 100000);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/OLLAMA_REQUEST_BUDGET_MS \(120000\).*OLLAMA_TIMEOUT_MS \(120000\)/);
    expect(w[1]).toMatch(/OLLAMA_COACH_NOTE_BUDGET_MS \(100000\).*OLLAMA_TIMEOUT_MS \(120000\)/);
  });

  it('warns about only the budget that is too small', () => {
    const w = ollamaTimingWarnings(130000, 170000, 120000);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/OLLAMA_COACH_NOTE_BUDGET_MS/);
  });

  it('warns when the timeout is not a finite positive number', () => {
    for (const bad of [NaN, Infinity, 0, -5]) {
      const w = ollamaTimingWarnings(bad, 170000, 120000);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/OLLAMA_TIMEOUT_MS is /);
    }
  });
});
