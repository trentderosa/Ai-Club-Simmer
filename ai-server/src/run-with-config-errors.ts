import { ConfigError } from './config.js';

export interface ConfigErrorIo {
  exit: (code: number) => never;
  stderr: { write: (text: string, callback?: () => void) => unknown };
}

/**
 * Run startup code. A ConfigError prints one line to stderr
 * (`Config error: <message>`, variable names and ranges only) and exits 1.
 * Any other error is rethrown so it surfaces normally.
 *
 * stderr writes to a pipe can be async (macOS), so the exit runs from the
 * write callback, after the line is flushed. On a ConfigError the returned
 * promise never settles, so a caller that awaits it (index.ts uses top-level
 * await) cannot continue startup before the process exits.
 */
export async function runWithConfigErrors<T>(fn: () => T, { exit, stderr }: ConfigErrorIo): Promise<T> {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`Config error: ${error.message}\n`, () => exit(1));
      return new Promise<never>(() => {});
    }
    throw error;
  }
}
