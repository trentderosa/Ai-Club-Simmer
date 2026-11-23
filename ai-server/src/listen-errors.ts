import type { Server } from 'http';

/** One-line message for a failed listen(). Host, port and error code only; never env values or stacks. */
export function describeListenError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE') {
    return `Server error: port ${port} on ${host} is already in use (EADDRINUSE)`;
  }
  if (code === 'EACCES') {
    return `Server error: no permission to use port ${port} on ${host} (EACCES)`;
  }
  const name = err instanceof Error ? err.name : 'Error';
  return `Server error: ${name}${code ? ` (${code})` : ''}`;
}

/** Log one clean line to stderr and exit 1 when the server cannot listen. */
export function handleListenError(err: unknown, host: string, port: number): never {
  console.error(describeListenError(err, host, port));
  process.exit(1);
}

/** The port the server actually bound (differs from the requested one when PORT=0). */
export function boundPort(server: Server, fallback: number): number {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : fallback;
}
