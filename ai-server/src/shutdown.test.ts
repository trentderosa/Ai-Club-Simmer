import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createShutdown } from './shutdown.js';

function setup(): {
  server: { close: ReturnType<typeof vi.fn>; closeIdleConnections: ReturnType<typeof vi.fn> };
  scheduler: { enabled: true; stop: ReturnType<typeof vi.fn> };
  exit: ReturnType<typeof vi.fn>;
  handler: (signal: string) => void;
} {
  const server = { close: vi.fn(), closeIdleConnections: vi.fn() };
  const scheduler = { enabled: true as const, stop: vi.fn() };
  const exit = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const handler = createShutdown(server, scheduler, { forceExitMs: 65000, exit, logger });
  return { server, scheduler, exit, handler };
}

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first signal stops the scheduler and closes the server and idle connections', () => {
    const { server, scheduler, exit, handler } = setup();
    handler('SIGTERM');
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not call stop when the scheduler is disabled', () => {
    const server = { close: vi.fn() };
    const stop = vi.fn();
    const handler = createShutdown(server, { enabled: false, stop }, {
      forceExitMs: 1000,
      exit: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handler('SIGINT');
    expect(stop).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('a second signal exits 1 right away', () => {
    const { server, exit, handler } = setup();
    handler('SIGINT');
    handler('SIGINT');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('force-exits with 1 after forceExitMs', () => {
    const { exit, handler } = setup();
    handler('SIGTERM');
    vi.advanceTimersByTime(64999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 0 when the server closes cleanly', () => {
    const { server, exit, handler } = setup();
    handler('SIGTERM');
    const onClose = server.close.mock.calls[0]?.[0] as () => void;
    onClose();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
