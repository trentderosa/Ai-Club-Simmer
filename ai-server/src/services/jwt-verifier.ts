import jwt, { JwtPayload, VerifyOptions, Algorithm } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface JwtVerifyResult {
  valid: boolean;
  userId?: string;
  error?: 'missing_token' | 'invalid_token' | 'expired' | 'no_user_id' | 'service_unavailable';
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

  const ASYMMETRIC_ALGS: Algorithm[] = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

  const getSigningKey = async (
    header: jwt.JwtHeader
  ): Promise<{ key: string; algorithm: Algorithm }> => {
    const alg = header.alg as Algorithm;

    if (jwks && header.kid) {
      try {
        const signingKey = await jwks.getSigningKey(header.kid);
        const publicKey = signingKey.getPublicKey();
        const algorithm = alg || 'RS256';
        if (!ASYMMETRIC_ALGS.includes(algorithm)) {
          throw new Error(`Unsupported algorithm: ${algorithm}`);
        }
        return { key: publicKey, algorithm };
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('ECONNREFUSED') ||
            err.message.includes('ETIMEDOUT') ||
            err.message.includes('ENOTFOUND') ||
            err.message.includes('getaddrinfo') ||
            err.message.includes('socket'))
        ) {
          console.error('JWKS network error:', err.message);
          throw new JwksNetworkError(err.message);
        }
        throw err;
      }
    }

    if (jwtSecret) {
      if (alg === 'HS256') {
        return { key: jwtSecret, algorithm: 'HS256' };
      }
      if (ASYMMETRIC_ALGS.includes(alg)) {
        return { key: jwtSecret, algorithm: alg };
      }
      return { key: jwtSecret, algorithm: 'HS256' };
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

        const { key, algorithm } = await getSigningKey(decoded.header);

        const verifyOptions: VerifyOptions = {
          algorithms: [algorithm],
        };

        if (issuer) {
          verifyOptions.issuer = issuer;
        }
        if (audience) {
          verifyOptions.audience = audience;
        }

        const payload = jwt.verify(token, key, verifyOptions) as JwtPayload;

        const userId = payload.sub;
        if (!userId) {
          return { valid: false, error: 'no_user_id' };
        }

        return { valid: true, userId };
      } catch (err) {
        if (err instanceof JwksNetworkError) {
          return { valid: false, error: 'service_unavailable' };
        }
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

class JwksNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksNetworkError';
  }
}
