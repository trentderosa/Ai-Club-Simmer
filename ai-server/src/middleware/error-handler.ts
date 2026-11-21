import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response } from 'express';

/** JSON 404 for any route no router handled. */
export const notFoundHandler: RequestHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
};

/**
 * Final error handler. Body-parser failures get a specific 4xx; any other
 * exposable 4xx client error keeps its status with a generic body; everything
 * else is a generic 500. The response never carries a stack or error message,
 * and the 500 log line has only the error name (and a string code), never the
 * message, headers, body or tokens.
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

  const fields = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  if (fields.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON', code: 'INVALID_JSON' });
    return;
  }
  if (fields.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  // Other body-parser client errors (unsupported charset or encoding, aborted
  // request, bad length) are marked expose=true with a 4xx status.
  const status = typeof fields.status === 'number' ? fields.status : fields.statusCode;
  if (typeof status === 'number' && status >= 400 && status <= 499 && fields.expose === true) {
    if (status === 415) {
      res.status(415).json({ error: 'Unsupported request encoding', code: 'UNSUPPORTED_MEDIA_TYPE' });
    } else {
      res.status(status).json({ error: 'Bad request', code: 'BAD_REQUEST' });
    }
    return;
  }

  const name = err instanceof Error ? err.name : 'NonError';
  const code = typeof fields.code === 'string' ? ` (${fields.code})` : '';
  console.error(`Unhandled error: ${name}${code}`);
  res.status(500).json({ error: 'Internal server error' });
};

/** Mount last, after every router and health route. */
export function mountErrorHandlers(app: Express): void {
  app.use(notFoundHandler);
  app.use(errorHandler);
}
