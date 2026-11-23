import { describe, it, expect } from 'vitest';
import type { Server } from 'http';
import { boundPort, describeListenError } from './listen-errors.js';

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('listen failed with secret-value'), { code });
}

describe('describeListenError', () => {
  it('names host, port and code for EADDRINUSE', () => {
    expect(describeListenError(errWithCode('EADDRINUSE'), '127.0.0.1', 3001)).toBe(
      'Server error: port 3001 on 127.0.0.1 is already in use (EADDRINUSE)',
    );
  });

  it('names host, port and code for EACCES', () => {
    expect(describeListenError(errWithCode('EACCES'), '0.0.0.0', 80)).toBe(
      'Server error: no permission to use port 80 on 0.0.0.0 (EACCES)',
    );
  });

  it('logs only name and code for other errors, never the message', () => {
    const line = describeListenError(errWithCode('EINVAL'), '127.0.0.1', 3001);
    expect(line).toBe('Server error: Error (EINVAL)');
    expect(line).not.toContain('secret-value');
  });

  it('handles non-Error values', () => {
    expect(describeListenError('boom', '127.0.0.1', 3001)).toBe('Server error: Error');
    expect(describeListenError(null, '127.0.0.1', 3001)).toBe('Server error: Error');
  });
});

describe('boundPort', () => {
  it('returns the bound port from the server address', () => {
    expect(boundPort({ address: () => ({ port: 4242 }) } as unknown as Server, 0)).toBe(4242);
  });

  it('falls back when the address is not an object', () => {
    expect(boundPort({ address: () => null } as unknown as Server, 7)).toBe(7);
    expect(boundPort({ address: () => '/tmp/sock' } as unknown as Server, 7)).toBe(7);
  });
});
