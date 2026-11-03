import { Ollama } from 'ollama';
import type { ChatResponse } from 'ollama';

export interface OllamaClientConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface OllamaClient {
  generate(prompt: string, jsonSchema: object): Promise<string>;
}

type FetchFn = typeof fetch;

/**
 * Custom fetch wrapper that adds a timeout signal to all requests.
 * This is necessary because ollama-js 0.5.x chat() doesn't accept a signal directly.
 */
function createTimedFetch(timeoutMs: number): FetchFn {
  const timedFetch: FetchFn = (input, init) => {
    return fetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  return timedFetch;
}

/**
 * Creates an Ollama client with safety bounds.
 *
 * - maxTokens (num_predict): Caps output length to prevent runaway generation
 * - timeoutMs: Aborts requests via custom fetch with AbortSignal.timeout
 *
 * The timeout is wired through a custom fetch function because ollama-js 0.5.x
 * chat() doesn't accept a signal parameter directly. This ensures hung model
 * calls are properly aborted after the timeout.
 */
export function createOllamaClient(config: OllamaClientConfig): OllamaClient {
  const ollama = new Ollama({
    host: config.baseUrl,
    fetch: createTimedFetch(config.timeoutMs),
  });

  return {
    async generate(prompt: string, jsonSchema: object): Promise<string> {
      const response: ChatResponse = await ollama.chat({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        format: jsonSchema,
        options: {
          temperature: 0.7,
          num_predict: config.maxTokens,
        },
      });

      return response.message.content;
    },
  };
}

export { createTimedFetch };
