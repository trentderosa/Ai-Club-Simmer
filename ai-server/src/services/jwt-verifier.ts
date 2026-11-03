import jwt, { JwtPayload, VerifyOptions } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface JwtVerifyResult {
  valid: boolean;
  userId?: string;
  error?: 'missing_token' | 'invalid_token' | 'expired' | 'no_user_id';
}

export interface JwtVerifier {
  verify(token: string): Promise<JwtVerifyResult>;
}

export interface JwtVerifierConfig {
  jwtSecret?: string;
  jwksUri?: string;
  issuer?: string;
  audience?: string;
}

export function createJwtVerifier(config: JwtVerifierConfig): JwtVerifier {
  const { jwtSecret, jwksUri, issuer, audience } = config;

  if (!jwtSecret && !jwksUri) {
    throw new Error('Must provide either SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI');
  }

  let jwks: jwksClient.JwksClient | undefined;
  if (jwksUri) {
    jwks = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 600000,
      rateLimit: true,
    });
  }

  const getSigningKey = async (header: jwt.JwtHeader): Promise<string> => {
    if (jwtSecret) {
      return jwtSecret;
    }
    if (jwks && header.kid) {
      const key = await jwks.getSigningKey(header.kid);
      return key.getPublicKey();
    }
    throw new Error('No signing key available');
  };

  return {
    async verify(token: string): Promise<JwtVerifyResult> {
      if (!token) {
        return { valid: false, error: 'missing_token' };
      }

      try {
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || typeof decoded === 'string') {
          return { valid: false, error: 'invalid_token' };
        }

        const signingKey = await getSigningKey(decoded.header);

        const verifyOptions: VerifyOptions = {
          algorithms: jwtSecret ? ['HS256'] : ['RS256'],
        };

        if (issuer) {
          verifyOptions.issuer = issuer;
        }
        if (audience) {
          verifyOptions.audience = audience;
        }

        const payload = jwt.verify(token, signingKey, verifyOptions) as JwtPayload;

        const userId = payload.sub;
        if (!userId) {
          return { valid: false, error: 'no_user_id' };
        }

        return { valid: true, userId };
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          return { valid: false, error: 'expired' };
        }
        if (err instanceof jwt.JsonWebTokenError) {
          return { valid: false, error: 'invalid_token' };
        }
        return { valid: false, error: 'invalid_token' };
      }
    },
  };
}

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
