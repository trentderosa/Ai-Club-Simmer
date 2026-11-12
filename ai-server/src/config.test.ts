import { describe, it, expect } from 'vitest';
import { assertProductionConfig } from './config.js';

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
