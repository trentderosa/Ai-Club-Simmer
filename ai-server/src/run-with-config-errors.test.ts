import { describe, it, expect, vi, type Mock } from 'vitest';
import { runWithConfigErrors } from './run-with-config-errors.js';
import { ConfigError, parseBoundedIntEnv } from './config.js';

type Flush = () => void;

// stderr whose write callback is held until the test calls flush(), like an async pipe.
function asyncIo(): {
  exit: Mock<[number], never>;
  stderr: { write: Mock<[string, Flush?], void> };
  flush: () => void;
} {
  let flush: Flush = (): void => {};
  const exit = vi.fn((_code: number): never => undefined as never);
  const stderr = {
    write: vi.fn((_text: string, callback?: Flush): void => {
      flush = callback ?? ((): void => {});
    }),
  };
  return { exit, stderr, flush: (): void => flush() };
}

function io(): { exit: () => never; stderr: { write: ReturnType<typeof vi.fn> } } {
  return {
    exit: vi.fn((): never => {
      throw new Error('exit called');
    }),
    stderr: { write: vi.fn() },
  };
}

describe('runWithConfigErrors', () => {
  it('returns the value when nothing throws', async () => {
    const { exit, stderr } = io();
    await expect(runWithConfigErrors(() => 42, { exit: exit, stderr })).resolves.toBe(42);
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('prints one line, and exits 1 only after the write flushes', () => {
    const { exit, stderr, flush } = asyncIo();
    void runWithConfigErrors(
      () => {
        throw new ConfigError('FOO must be a whole number from 1 to 2');
      },
      { exit, stderr }
    );
    expect(stderr.write).toHaveBeenCalledTimes(1);
    expect(stderr.write.mock.calls[0][0]).toBe('Config error: FOO must be a whole number from 1 to 2\n');
    expect(exit).not.toHaveBeenCalled();
    flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('never resolves after a ConfigError, so startup cannot continue', async () => {
    const { exit, stderr } = asyncIo();
    const settled = vi.fn();
    void runWithConfigErrors(
      () => {
        throw new ConfigError('FOO bad');
      },
      { exit, stderr }
    ).then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
  });

  it('handles the error thrown by parseBoundedIntEnv without echoing the value', () => {
    const { exit, stderr } = asyncIo();
    void runWithConfigErrors(() => parseBoundedIntEnv({ X: 'hunter2-secret' }, 'X', 1, 0, 10), { exit, stderr });
    expect(stderr.write.mock.calls[0][0]).toBe('Config error: X must be a whole number from 0 to 10\n');
  });

  it('rethrows non-config errors without printing or exiting', async () => {
    const { exit, stderr } = io();
    const boom = new Error('boom');
    await expect(
      runWithConfigErrors(
        () => {
          throw boom;
        },
        { exit: exit, stderr }
      )
    ).rejects.toBe(boom);
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
