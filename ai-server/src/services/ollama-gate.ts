import type { OllamaClient, OllamaGenerateOptions } from './ollama-client.js';

export interface OllamaGateConfig {
  /** Model calls running at once. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot. 0 means none wait. */
  maxQueue: number;
  /** Longest a call waits for a slot, in ms. A per-call 0 means do not wait. */
  queueTimeoutMs: number;
}

export type OllamaBusyReason = 'queue_full' | 'queue_timeout';

/** Thrown when the model is too busy to take a call. Callers must not retry it. */
export class OllamaBusyError extends Error {
  readonly reason: OllamaBusyReason;

  constructor(reason: OllamaBusyReason) {
    super(`Ollama is busy (${reason})`);
    this.name = 'OllamaBusyError';
    this.reason = reason;
  }
}

export interface OllamaGate extends OllamaClient {
  /** True when every slot is busy and the queue is full: a new call would be refused. */
  isSaturated(): boolean;
  /** True when nothing is running and nothing is waiting. */
  isIdle(): boolean;
}

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Wraps an OllamaClient so every call shares one FIFO queue. The inner
 * client's own timeout starts only once a slot is held, so time spent waiting
 * never counts against it. A slot is released on success, error and timeout.
 * Logs the reason and counts only: never prompts or user text.
 */
export function createOllamaGate(inner: OllamaClient, config: OllamaGateConfig): OllamaGate {
  let running = 0;
  const queue: Waiter[] = [];

  function busy(reason: OllamaBusyReason): OllamaBusyError {
    console.warn('ollama_busy', { reason, running, queued: queue.length });
    return new OllamaBusyError(reason);
  }

  function release(): void {
    const next = queue.shift();
    if (next) {
      // Hand the slot straight to the oldest waiter; running is unchanged.
      clearTimeout(next.timer);
      next.grant();
      return;
    }
    running -= 1;
  }

  function acquire(queueTimeoutMs: number): Promise<void> {
    if (running < config.maxConcurrent) {
      running += 1;
      return Promise.resolve();
    }
    if (queue.length >= config.maxQueue) {
      return Promise.reject(busy('queue_full'));
    }
    // Zero (or less) means never wait: no free slot is an immediate busy answer.
    if (queueTimeoutMs <= 0) {
      return Promise.reject(busy('queue_timeout'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          reject(busy('queue_timeout'));
        }, queueTimeoutMs),
      };
      queue.push(waiter);
    });
  }

  return {
    async generate(
      prompt: string,
      jsonSchema: object,
      options: OllamaGenerateOptions = {}
    ): Promise<string> {
      await acquire(options.queueTimeoutMs ?? config.queueTimeoutMs);
      try {
        return await inner.generate(prompt, jsonSchema);
      } finally {
        release();
      }
    },
    isSaturated: () => running >= config.maxConcurrent && queue.length >= config.maxQueue,
    isIdle: () => running === 0 && queue.length === 0,
  };
}
