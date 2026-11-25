import type { Response } from 'express';

/** 503 sent when a Supabase request timed out. The app shows "try again" copy for it. */
export function sendDatabaseUnavailable(res: Response): void {
  res.status(503).json({
    error: 'The database is not responding right now. Try again in a moment.',
    code: 'DATABASE_UNAVAILABLE',
  });
}
