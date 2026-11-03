import type { Request, Response, NextFunction } from 'express';
import type { JwtVerifier } from '../services/jwt-verifier.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Creates an authentication middleware using the provided JWT verifier.
 * Sets req.userId on successful authentication.
 * 
 * This middleware runs BEFORE rate limiting so that the rate limiter
 * can use the authenticated user ID as the key (B3 fix).
 */
export function createAuthMiddleware(jwtVerifier: JwtVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Missing or invalid authorization header',
      });
      return;
    }

    const token = authHeader.slice(7);
    const authResult = await jwtVerifier.verify(token);

    if (authResult.error === 'service_unavailable') {
      res.status(503).json({ error: 'Authentication service unavailable' });
      return;
    }

    if (!authResult.valid || !authResult.userId) {
      const errorMessage = authResult.error === 'expired' 
        ? 'Token expired' 
        : 'Invalid or expired token';
      res.status(401).json({ error: errorMessage });
      return;
    }

    req.userId = authResult.userId;
    next();
  };
}
