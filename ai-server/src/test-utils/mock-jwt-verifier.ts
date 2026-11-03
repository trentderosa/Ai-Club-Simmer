import type { JwtVerifier, JwtVerifyResult } from '../services/jwt-verifier.js';

export function createMockJwtVerifier(
  validTokens: Map<string, string>
): JwtVerifier {
  return {
    verify(token: string): Promise<JwtVerifyResult> {
      if (!token) {
        return Promise.resolve({ valid: false, error: 'missing_token' });
      }
      const userId = validTokens.get(token);
      if (userId) {
        return Promise.resolve({ valid: true, userId });
      }
      return Promise.resolve({ valid: false, error: 'invalid_token' });
    },
  };
}
