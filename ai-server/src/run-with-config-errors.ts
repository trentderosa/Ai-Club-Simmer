import { ConfigError } from './config.js';

export interface ConfigErrorIo {
  exit: (code: number) => never;
  stderr: { write: (text: string) => unknown };
}

/**
 * Run startup code. A ConfigError prints one line to stderr
 * (`Config error: <message>`, variable names and ranges only) and exits 1.
 * Any other error is rethrown so it surfaces normally.
 */
export function runWithConfigErrors<T>(fn: () => T, { exit, stderr }: ConfigErrorIo): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`Config error: ${error.message}\n`);
      return exit(1);
    }
    throw error;
  }
}
