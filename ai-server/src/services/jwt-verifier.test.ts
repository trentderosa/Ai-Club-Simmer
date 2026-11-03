import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { createJwtVerifier } from './jwt-verifier.js';
import { createMockJwtVerifier } from '../test-utils/mock-jwt-verifier.js';

const TEST_SECRET = 'test-jwt-secret-for-unit-tests';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

function createValidToken(
  userId: string,
  options: { expiresIn?: string } = {}
): string {
  return jwt.sign({ sub: userId }, TEST_SECRET, {
    algorithm: 'HS256',
    expiresIn: options.expiresIn ?? '1h',
  } as jwt.SignOptions);
}

function createExpiredToken(userId: string): string {
  return jwt.sign({ sub: userId }, TEST_SECRET, {
    algorithm: 'HS256',
    expiresIn: '-1h',
  } as jwt.SignOptions);
}

describe('createJwtVerifier', () => {
  it('throws if neither jwtSecret nor jwksUri is provided', () => {
    expect(() => createJwtVerifier({})).toThrow(
      'Must provide either SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI'
    );
  });

  describe('with jwtSecret (HS256)', () => {
    const verifier = createJwtVerifier({ jwtSecret: TEST_SECRET });

    it('returns valid: true and userId for a valid token', async () => {
      const token = createValidToken(TEST_USER_ID);
      const result = await verifier.verify(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(TEST_USER_ID);
      expect(result.error).toBeUndefined();
    });

    it('returns valid: false with error "expired" for an expired token', async () => {
      const token = createExpiredToken(TEST_USER_ID);
      const result = await verifier.verify(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('expired');
      expect(result.userId).toBeUndefined();
    });

    it('returns valid: false with error "invalid_token" for a token signed with wrong secret', async () => {
      const token = jwt.sign({ sub: TEST_USER_ID }, 'wrong-secret', {
        algorithm: 'HS256',
      });
      const result = await verifier.verify(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_token');
    });

    it('returns valid: false with error "invalid_token" for malformed token', async () => {
      const result = await verifier.verify('not-a-valid-jwt');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_token');
    });

    it('returns valid: false with error "missing_token" for empty string', async () => {
      const result = await verifier.verify('');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('missing_token');
    });

    it('returns valid: false with error "no_user_id" for token without sub claim', async () => {
      const token = jwt.sign({ foo: 'bar' }, TEST_SECRET, {
        algorithm: 'HS256',
      });
      const result = await verifier.verify(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('no_user_id');
    });

    it('extracts user ID from the sub claim', async () => {
      const customUserId = 'user-abc-123';
      const token = createValidToken(customUserId);
      const result = await verifier.verify(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(customUserId);
    });

    it('accepts HS256 token when both jwtSecret and jwksUri are configured', async () => {
      const verifier = createJwtVerifier({
        jwtSecret: TEST_SECRET,
        jwksUri: 'https://example.com/.well-known/jwks.json',
      });
      const token = createValidToken(TEST_USER_ID);

      const result = await verifier.verify(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(TEST_USER_ID);
    });
  });

  describe('asymmetric key verification', () => {
    it('accepts RS256 token when jwtSecret is the public key', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const token = jwt.sign({ sub: TEST_USER_ID }, privateKey, {
        algorithm: 'RS256',
      } as jwt.SignOptions);

      const verifier = createJwtVerifier({ jwtSecret: publicKey });
      const result = await verifier.verify(token);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(TEST_USER_ID);
    });

    it('rejects token signed with different RSA key', async () => {
      const { privateKey: privateKey1 } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const { publicKey: publicKey2 } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const token = jwt.sign({ sub: TEST_USER_ID }, privateKey1, {
        algorithm: 'RS256',
      } as jwt.SignOptions);

      const verifier = createJwtVerifier({ jwtSecret: publicKey2 });
      const result = await verifier.verify(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_token');
    });
  });
});

describe('createMockJwtVerifier', () => {
  it('returns valid: true for tokens in the map', async () => {
    const validTokens = new Map([['token-a', 'user-a']]);
    const verifier = createMockJwtVerifier(validTokens);

    const result = await verifier.verify('token-a');

    expect(result.valid).toBe(true);
    expect(result.userId).toBe('user-a');
  });

  it('returns valid: false for tokens not in the map', async () => {
    const validTokens = new Map([['token-a', 'user-a']]);
    const verifier = createMockJwtVerifier(validTokens);

    const result = await verifier.verify('unknown-token');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_token');
  });

  it('returns valid: false for empty token', async () => {
    const verifier = createMockJwtVerifier(new Map());

    const result = await verifier.verify('');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('missing_token');
  });
});
