import { describe, it, expect } from 'vitest';
import { assertProductionConfig, loadXpAwardTimeoutMs, parseBoundedIntEnv } from './config.js';

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
