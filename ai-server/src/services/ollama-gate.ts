import type { OllamaClient, OllamaGenerateOptions } from './ollama-client.js';

export interface OllamaGateConfig {
  /** Model calls running at once. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot. 0 means none wait. */
  maxQueue: number;
  /** Longest a call waits for a slot, in ms. A per-call 0 means do not wait. */
  queueTimeoutMs: number;
}

export type OllamaBusyReason = 'queue_full' | 'queue_timeout' | 'shutting_down';

/** Thrown when the model is too busy to take a call. Callers must not retry it. */
export class OllamaBusyError extends Error {
  readonly reason: OllamaBusyReason;

  constructor(reason: OllamaBusyReason) {
    super(`Ollama is busy (${reason})`);
    this.name = 'OllamaBusyError';
    this.reason = reason;
  }
}

/**
 * Thrown when a background call (a prewarm) was cancelled because a real
 * request needed its slot. Callers must not retry it.
 */
export class OllamaPreemptedError extends Error {
  constructor() {
    super('Ollama call was preempted by a foreground request');
    this.name = 'OllamaPreemptedError';
  }
}

export interface OllamaGate extends OllamaClient {
  /**
   * True when a foreground call would be refused: every slot is busy with a
   * foreground call and the queue is full. Running background calls do not count,
   * because a foreground call can preempt one.
   */
  isSaturated(): boolean;
  /** True when nothing is running and nothing is waiting. */
  isIdle(): boolean;
  /**
   * Shutdown: rejects every queued waiter and every later call with a busy
   * error (reason shutting_down) and aborts running background calls, which
   * also end with that busy error. Running foreground calls keep their slot
   * and finish on their own timeout. Idempotent.
   */
  close(): void;
}

interface Waiter {
  /**
   * Set when this waiter cancelled a background call. Its hand-off is already
   * reserved, so it does not count against maxQueue.
   */
  reserved: boolean;
  grant: () => void;
  reject: (error: OllamaBusyError) => void;
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
  // Running background calls that have not been told to stop, oldest first.
  const preemptible: Array<{ controller: AbortController; preempted: boolean }> = [];
  // Background calls cut short by close(), so they end busy rather than preempted.
  const closedEntries = new WeakSet<object>();
  let closed = false;

  /** Waiters that count against maxQueue (those not waiting on a preempted call). */
  function queuedCount(): number {
    return queue.filter((waiter) => !waiter.reserved).length;
  }

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

  /** Cancel one running background call so its slot frees up for a waiter. */
  function preemptOneBackground(): void {
    const victim = preemptible.shift();
    if (!victim) return;
    victim.preempted = true;
    console.warn('ollama_preempt', { running, queued: queue.length });
    victim.controller.abort();
  }

  function acquire(queueTimeoutMs: number, background: boolean): Promise<void> {
    if (closed) {
      return Promise.reject(busy('shutting_down'));
    }
    if (running < config.maxConcurrent) {
      running += 1;
      return Promise.resolve();
    }
    // A foreground call can take over a running background call's slot, so a full
    // queue (or maxQueue 0) does not refuse it while one is running.
    const canPreempt = !background && preemptible.length > 0;
    if (!canPreempt && queuedCount() >= config.maxQueue) {
      return Promise.reject(busy('queue_full'));
    }
    // Zero (or less) means never wait: no free slot is an immediate busy answer.
    if (queueTimeoutMs <= 0) {
      return Promise.reject(busy('queue_timeout'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        reserved: false,
        grant: resolve,
        reject,
        timer: setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          reject(busy('queue_timeout'));
        }, queueTimeoutMs),
      };
      queue.push(waiter);
      // A real request that must wait takes the slot of a running prewarm.
      // Each waiter cancels at most one call, so one prewarm is never cancelled twice.
      // The queue stays FIFO: the freed slot goes to the oldest waiter, which may be an
      // earlier foreground call; this one then waits for the next release.
      if (canPreempt) {
        waiter.reserved = true;
        preemptOneBackground();
      }
    });
  }

  return {
    async generate(
      prompt: string,
      jsonSchema: object,
      options: OllamaGenerateOptions = {}
    ): Promise<string> {
      const background = options.background === true;
      await acquire(options.queueTimeoutMs ?? config.queueTimeoutMs, background);
      if (!background) {
        try {
          return await inner.generate(prompt, jsonSchema);
        } finally {
          release();
        }
      }
      // close() may have run while acquire() was resolving; this call is not in
      // `preemptible` yet, so close() could not abort it. Refuse it here instead.
      if (closed) {
        release();
        throw busy('shutting_down');
      }
      const entry = { controller: new AbortController(), preempted: false };
      preemptible.push(entry);
      try {
        return await inner.generate(prompt, jsonSchema, { signal: entry.controller.signal });
      } catch (error) {
        if (closedEntries.has(entry)) throw busy('shutting_down');
        if (entry.preempted) throw new OllamaPreemptedError();
        throw error;
      } finally {
        const index = preemptible.indexOf(entry);
        if (index !== -1) preemptible.splice(index, 1);
        release();
      }
    },
    // A closed gate reports saturated so routes refuse before spending anything.
    isSaturated: () =>
      closed ||
      running >= config.maxConcurrent &&
      preemptible.length === 0 &&
      queuedCount() >= config.maxQueue,
    isIdle: () => running === 0 && queue.length === 0,
    close(): void {
      if (closed) return;
      closed = true;
      const waiting = queue.splice(0, queue.length);
      const background = preemptible.splice(0, preemptible.length);
      console.warn('ollama_gate_closed', {
        running,
        rejectedQueued: waiting.length,
        abortedBackground: background.length,
      });
      for (const waiter of waiting) {
        clearTimeout(waiter.timer);
        waiter.reject(new OllamaBusyError('shutting_down'));
      }
      for (const entry of background) {
        closedEntries.add(entry);
        entry.controller.abort();
      }
    },
  };
}
