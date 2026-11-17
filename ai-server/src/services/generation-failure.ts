function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a Node-style error `code` (ECONNREFUSED, ENOTFOUND, …) from the
 * error or its `cause` chain. Used only in server logs, never in client
 * responses.
 */
export function errorCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (isRecord(current) && typeof current.code === 'string' && current.code.length > 0) {
      return current.code;
    }
    current = current instanceof Error ? current.cause : isRecord(current) ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Host only (no userinfo or path) so a down Ollama is obvious without
 * logging a raw URL that might carry a query token.
 */
export function ollamaHost(
  baseUrl: string = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid-ollama-url';
  }
}

export interface GenerationFailureLog {
  message: string;
  cause?: string;
  ollama_host: string;
}

export function describeGenerationFailure(
  error: unknown,
  ollamaBaseUrl?: string
): GenerationFailureLog {
  const message =
    error instanceof Error
      ? `Generation failed: ${error.message || 'Unknown error'}`
      : `Generation failed: ${String(error) || 'Unknown error'}`;
  const cause = errorCauseCode(error);
  const log: GenerationFailureLog = {
    message,
    ollama_host: ollamaHost(ollamaBaseUrl),
  };
  if (cause) log.cause = cause;
  return log;
}

export function logGenerationFailure(error: unknown, ollamaBaseUrl?: string): void {
  console.error('recipe_generation_failed', describeGenerationFailure(error, ollamaBaseUrl));
}
