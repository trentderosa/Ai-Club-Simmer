import { Ollama } from 'ollama';
import type { ChatResponse } from 'ollama';

export interface OllamaClientConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

/** Per-call options. The shared concurrency gate and the client read them. */
export interface OllamaGenerateOptions {
  /** Longest this call may wait for a model slot, in ms. Gate default if unset. */
  queueTimeoutMs?: number;
  /**
   * Background work (a prewarm). The gate cancels it when a real request has to
   * wait for a slot; it then throws OllamaPreemptedError.
   */
  background?: boolean;
  /** Aborts the call. Set by the gate for background calls; combined with the timeout. */
  signal?: AbortSignal;
}

export interface OllamaClient {
  generate(prompt: string, jsonSchema: object, options?: OllamaGenerateOptions): Promise<string>;
}

type FetchFn = typeof fetch;

/** AbortSignal.any needs Node 20.3+; engines allow 18, so fall back to a manual combiner. */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const cleanup = (): void => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      cleanup();
      break;
    }
    const listener = (): void => {
      controller.abort(signal.reason);
      cleanup();
    };
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
}

/**
 * Custom fetch wrapper that adds a timeout signal to all requests, combined
 * with an optional caller signal. This is necessary because ollama-js 0.5.x
 * chat() doesn't accept a signal directly.
 */
function createTimedFetch(timeoutMs: number, signal?: AbortSignal): FetchFn {
  const timedFetch: FetchFn = (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(input, {
      ...init,
      signal: signal ? combineSignals([timeout, signal]) : timeout,
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
  return {
    async generate(
      prompt: string,
      jsonSchema: object,
      options: OllamaGenerateOptions = {}
    ): Promise<string> {
      // One lightweight Ollama object per call, so the fetch closes over this
      // call's signal. Aborting the fetch closes the HTTP request, and Ollama
      // stops generating when the client disconnects, so a cancelled call
      // frees the model and does not keep running server-side.
      const ollama = new Ollama({
        host: config.baseUrl,
        fetch: createTimedFetch(config.timeoutMs, options.signal),
      });
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
