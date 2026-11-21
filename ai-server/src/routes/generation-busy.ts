import type { Response } from 'express';

/** Seconds a client is told to wait before trying again. */
export const GENERATION_BUSY_RETRY_AFTER_SECONDS = 30;

/** 503 sent when the shared model queue is full or the wait ran out. */
export function sendGenerationBusy(res: Response): void {
  res
    .status(503)
    .set('Retry-After', String(GENERATION_BUSY_RETRY_AFTER_SECONDS))
    .json({
      error: `The kitchen is busy right now. Try again in about ${GENERATION_BUSY_RETRY_AFTER_SECONDS} seconds.`,
      code: 'GENERATION_BUSY',
    });
}
