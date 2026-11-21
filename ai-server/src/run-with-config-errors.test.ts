import { describe, it, expect, vi } from 'vitest';
import { runWithConfigErrors } from './run-with-config-errors.js';
import { ConfigError, parseBoundedIntEnv } from './config.js';

function io(): { exit: () => never; stderr: { write: ReturnType<typeof vi.fn> } } {
  return {
    exit: vi.fn((): never => {
      throw new Error('exit called');
    }),
    stderr: { write: vi.fn() },
  };
}

describe('runWithConfigErrors', () => {
  it('returns the value when nothing throws', () => {
    const { exit, stderr } = io();
    expect(runWithConfigErrors(() => 42, { exit: exit, stderr })).toBe(42);
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('prints one line and exits 1 on a ConfigError', () => {
    const exit = vi.fn((): never => undefined as never);
    const stderr = { write: vi.fn() };
    runWithConfigErrors(
      () => {
        throw new ConfigError('FOO must be a whole number from 1 to 2');
      },
      { exit, stderr }
    );
    expect(stderr.write).toHaveBeenCalledTimes(1);
    expect(stderr.write).toHaveBeenCalledWith('Config error: FOO must be a whole number from 1 to 2\n');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('handles the error thrown by parseBoundedIntEnv without echoing the value', () => {
    const exit = vi.fn((): never => undefined as never);
    const stderr = { write: vi.fn() };
    runWithConfigErrors(() => parseBoundedIntEnv({ X: 'hunter2-secret' }, 'X', 1, 0, 10), { exit, stderr });
    expect(stderr.write).toHaveBeenCalledWith('Config error: X must be a whole number from 0 to 10\n');
  });

  it('rethrows non-config errors without printing or exiting', () => {
    const { exit, stderr } = io();
    const boom = new Error('boom');
    expect(() =>
      runWithConfigErrors(
        () => {
          throw boom;
        },
        { exit: exit, stderr }
      )
    ).toThrow(boom);
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
