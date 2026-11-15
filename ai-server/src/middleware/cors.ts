import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Headers the Expo web client sends today, plus Idempotency-Key for retried check-ins. */
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key'] as const;

/** Methods used by /health (GET) and the recipe and check-in routes (POST). */
export const CORS_ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'] as const;

/**
 * Echo an allowed Origin back, add Vary: Origin, and answer OPTIONS preflight.
 * Unknown or missing origins get no Access-Control-Allow-* headers. Never
 * emits Access-Control-Allow-Origin: * or Access-Control-Allow-Credentials.
 */
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req: Request, res: Response, next: NextFunction): void => {
    res.vary('Origin');

    const origin = req.headers.origin;
    const allowedOrigin = typeof origin === 'string' && allowed.has(origin) ? origin : null;

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    }

    if (req.method === 'OPTIONS') {
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS.join(', '));
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS.join(', '));
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
      // Preflight from an unknown origin: no CORS allow headers.
      res.status(403).end();
      return;
    }

    next();
  };
}
