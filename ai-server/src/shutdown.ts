export interface ShutdownServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeIdleConnections?: () => void;
}

export interface ShutdownScheduler {
  enabled: boolean;
  stop?: () => void;
}

export interface ShutdownOptions {
  /** Hard stop after the first signal if connections are still open. */
  forceExitMs: number;
  exit: (code: number) => void;
  logger: Pick<Console, 'info' | 'warn'>;
  /** Closes the model gate: queued calls get a busy error, new calls are refused. */
  closeGate?: () => void;
}

/** Extra time on top of the model timeout so an in-flight attempt can finish. */
export const SHUTDOWN_GRACE_MS = 5000;

/**
 * Graceful shutdown handler for SIGTERM and SIGINT. The first signal stops the
 * reconcile timer, closes the model gate and the listener, then force-exits
 * after forceExitMs (the timer is unref'd). A second signal exits right away. A clean close exits 0.
 */
export function createShutdown(
  server: ShutdownServer,
  scheduler: ShutdownScheduler,
  { forceExitMs, exit, logger, closeGate }: ShutdownOptions
): (signal: string) => void {
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) {
      logger.warn(`${signal} received again, exiting now`);
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    if (scheduler.enabled) scheduler.stop?.();
    // Queued requests get 503 GENERATION_BUSY now instead of being cut off at
    // the force-exit. Calls already running finish within the model timeout.
    closeGate?.();
    const forceTimer = setTimeout(() => exit(1), forceExitMs);
    forceTimer.unref();
    server.close(() => {
      exit(0);
    });
    server.closeIdleConnections?.();
  };
}
