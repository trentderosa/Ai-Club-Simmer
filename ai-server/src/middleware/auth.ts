import type { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';
import type { AuthenticatedUser } from '../types/user.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

let cachedSecret: Uint8Array | null = null;

function getJwtSecret(): Uint8Array {
  if (cachedSecret) {
    return cachedSecret;
  }
  
  if (!SUPABASE_JWT_SECRET) {
    throw new Error('SUPABASE_JWT_SECRET environment variable is required');
  }
  
  cachedSecret = new TextEncoder().encode(SUPABASE_JWT_SECRET);
  return cachedSecret;
}

/**
 * Express middleware that verifies Supabase JWT tokens.
 * Expects Authorization header with "Bearer <token>" format.
 * Sets req.user with the authenticated user's ID and email.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ error: 'Invalid Authorization header format' });
    return;
  }

  const token = parts[1];

  try {
    const secret = getJwtSecret();
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    if (!payload.sub) {
      res.status(401).json({ error: 'Invalid token: missing subject' });
      return;
    }

    req.user = {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };

    next();
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (
      error instanceof jose.errors.JWTInvalid ||
      error instanceof jose.errors.JWSInvalid ||
      error instanceof jose.errors.JWSSignatureVerificationFailed
    ) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Creates a test JWT for use in tests (NOT for production).
 * Only works when SUPABASE_JWT_SECRET is set.
 */
export async function createTestJwt(userId: string, email?: string): Promise<string> {
  const secret = getJwtSecret();
  
  const token = await new jose.SignJWT({
    sub: userId,
    email,
    aud: 'authenticated',
    role: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);

  return token;
}

/**
 * Creates an expired test JWT for testing token expiration.
 */
export async function createExpiredTestJwt(userId: string): Promise<string> {
  const secret = getJwtSecret();
  
  const token = await new jose.SignJWT({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(secret);

  return token;
}
