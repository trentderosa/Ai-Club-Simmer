import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response } from 'express';

/** JSON 404 for any route no router handled. */
export const notFoundHandler: RequestHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
};

/**
 * Final error handler. Body-parser failures get a specific 4xx; everything
 * else is a generic 500. The response never carries a stack or error message,
 * and the log line has only the error name and message (no headers, body or
 * tokens).
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const type = typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined;
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON', code: 'INVALID_JSON' });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  const name = err instanceof Error ? err.name : 'NonError';
  const message = err instanceof Error ? err.message : '';
  console.error(`Unhandled error: ${name}: ${message}`);
  res.status(500).json({ error: 'Internal server error' });
};

/** Mount last, after every router and health route. */
export function mountErrorHandlers(app: Express): void {
  app.use(notFoundHandler);
  app.use(errorHandler);
}
