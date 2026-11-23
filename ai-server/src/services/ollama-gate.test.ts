import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaClient } from './ollama-client.js';
import { createOllamaGate, OllamaBusyError, OllamaPreemptedError } from './ollama-gate.js';

interface Deferred {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

/** An inner client whose calls stay pending until the test settles them. */
function controllableClient(): { client: OllamaClient; calls: Deferred[]; prompts: string[] } {
  const calls: Deferred[] = [];
  const prompts: string[] = [];
  const client: OllamaClient = {
    generate: (prompt) =>
      new Promise<string>((resolve, reject) => {
        prompts.push(prompt);
        calls.push({ resolve, reject });
      }),
  };
  return { client, calls, prompts };
}

/** Let the gate hand slots to waiters and start inner calls. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const config = { maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1000 };

describe('createOllamaGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs queued calls in FIFO order', async () => {
    const { client, calls, prompts } = controllableClient();
    const gate = createOllamaGate(client, config);
    const first = gate.generate('a', {});
    const second = gate.generate('b', {});
    const third = gate.generate('c', {});
    await flush();
    expect(prompts).toEqual(['a']);
    calls[0].resolve('ra');
    await expect(first).resolves.toBe('ra');
    await flush();
    expect(prompts).toEqual(['a', 'b']);
    calls[1].resolve('rb');
    await expect(second).resolves.toBe('rb');
    await flush();
    expect(prompts).toEqual(['a', 'b', 'c']);
    calls[2].resolve('rc');
    await expect(third).resolves.toBe('rc');
    expect(gate.isIdle()).toBe(true);
  });

  it('never runs more calls than maxConcurrent', async () => {
    const { client, calls, prompts } = controllableClient();
    const gate = createOllamaGate(client, { ...config, maxConcurrent: 2, maxQueue: 5 });
    const all = ['a', 'b', 'c', 'd'].map((p) => gate.generate(p, {}));
    await flush();
    expect(prompts).toEqual(['a', 'b']);
    calls[0].resolve('1');
    await vi.advanceTimersByTimeAsync(0);
    expect(prompts).toEqual(['a', 'b', 'c']);
    calls[1].resolve('2');
    calls[2].resolve('3');
    await vi.advanceTimersByTimeAsync(0);
    calls[3].resolve('4');
    await expect(Promise.all(all)).resolves.toEqual(['1', '2', '3', '4']);
  });

  it('throws OllamaBusyError queue_full without calling the model, and logs counts only', async () => {
    const { client, calls, prompts } = controllableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 1 });
    const running = gate.generate('secret prompt', {});
    const waiting = gate.generate('b', {});
    await flush();
    await expect(gate.generate('c', {})).rejects.toMatchObject({
      name: 'OllamaBusyError',
      reason: 'queue_full',
    });
    expect(prompts).toEqual(['secret prompt']);
    expect(console.warn).toHaveBeenCalledWith('ollama_busy', {
      reason: 'queue_full',
      running: 1,
      queued: 1,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret prompt');
    calls[0].resolve('x');
    await running;
    await flush();
    calls[1].resolve('y');
    await waiting;
  });

  it('refuses to wait at all when maxQueue is 0', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 0 });
    const running = gate.generate('a', {});
    await flush();
    expect(gate.isSaturated()).toBe(true);
    await expect(gate.generate('b', {})).rejects.toBeInstanceOf(OllamaBusyError);
    calls[0].resolve('x');
    await running;
  });

  it('times out a waiter with queue_timeout and removes it from the queue', async () => {
    const { client, calls, prompts } = controllableClient();
    const gate = createOllamaGate(client, config);
    const running = gate.generate('a', {});
    const waiter = gate.generate('b', {});
    await flush();
    const rejected = expect(waiter).rejects.toMatchObject({ reason: 'queue_timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(console.warn).toHaveBeenCalledWith('ollama_busy', {
      reason: 'queue_timeout',
      running: 1,
      queued: 0,
    });
    calls[0].resolve('x');
    await running;
    // The removed waiter never reaches the model, and the gate is free again.
    expect(prompts).toEqual(['a']);
    expect(gate.isIdle()).toBe(true);
  });

  it('calls the inner client only after the slot is held, so its timeout starts after the wait', async () => {
    const { client, calls } = controllableClient();
    const generate = vi.spyOn(client, 'generate');
    const gate = createOllamaGate(client, config);
    const first = gate.generate('a', {});
    const second = gate.generate('b', {});
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(generate).toHaveBeenCalledTimes(1);
    calls[0].resolve('x');
    await first;
    await flush();
    // The second call reaches the inner client only now, after its queue wait.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toBe('b');
    calls[1].resolve('y');
    await second;
  });

  it('uses a per-call queue timeout when given', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, config);
    const running = gate.generate('a', {});
    const waiter = gate.generate('b', {}, { queueTimeoutMs: 50 });
    await flush();
    const rejected = expect(waiter).rejects.toMatchObject({ reason: 'queue_timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    calls[0].resolve('x');
    await running;
  });

  it('a zero queue wait takes a free slot but is refused at once when none is free', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, config);
    const first = gate.generate('a', {}, { queueTimeoutMs: 0 });
    await flush();
    expect(calls).toHaveLength(1);
    await expect(gate.generate('b', {}, { queueTimeoutMs: 0 })).rejects.toMatchObject({
      reason: 'queue_timeout',
    });
    // The refused call never joined the queue.
    expect(gate.isIdle()).toBe(false);
    calls[0].resolve('x');
    await first;
    expect(gate.isIdle()).toBe(true);
  });

  it('does not time out a waiter that gets its slot in time', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, config);
    const running = gate.generate('a', {});
    const waiter = gate.generate('b', {});
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    calls[0].resolve('x');
    await running;
    await vi.advanceTimersByTimeAsync(2000);
    calls[1].resolve('y');
    await expect(waiter).resolves.toBe('y');
  });

  it('releases the slot when the inner call throws (including a timeout abort)', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, config);
    const first = gate.generate('a', {});
    const second = gate.generate('b', {});
    await flush();
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const firstRejected = expect(first).rejects.toBe(abort);
    calls[0].reject(abort);
    await firstRejected;
    await flush();
    expect(calls).toHaveLength(2);
    const secondRejected = expect(second).rejects.toThrow('boom');
    calls[1].reject(new Error('boom'));
    await secondRejected;
    expect(gate.isIdle()).toBe(true);
    const third = gate.generate('c', {});
    await flush();
    expect(calls).toHaveLength(3);
    calls[2].resolve('ok');
    await expect(third).resolves.toBe('ok');
  });

  it('reports isIdle and isSaturated', async () => {
    const { client, calls } = controllableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 1 });
    expect(gate.isIdle()).toBe(true);
    expect(gate.isSaturated()).toBe(false);
    const a = gate.generate('a', {});
    await flush();
    expect(gate.isIdle()).toBe(false);
    expect(gate.isSaturated()).toBe(false);
    const b = gate.generate('b', {});
    await flush();
    expect(gate.isSaturated()).toBe(true);
    calls[0].resolve('x');
    await a;
    await flush();
    expect(gate.isSaturated()).toBe(false);
    expect(gate.isIdle()).toBe(false);
    calls[1].resolve('y');
    await b;
    expect(gate.isIdle()).toBe(true);
  });
});

describe('createOllamaGate preemption of background calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Inner client that records each call's signal and rejects when it aborts. */
  function abortableClient(): { client: OllamaClient; starts: string[]; settle: Array<(v: string) => void> } {
    const starts: string[] = [];
    const settle: Array<(v: string) => void> = [];
    const client: OllamaClient = {
      generate: (prompt, _schema, options) =>
        new Promise<string>((resolve, reject) => {
          starts.push(prompt);
          settle.push(resolve);
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    return { client, starts, settle };
  }

  it('a foreground waiter preempts a running background call and starts at once', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    const background = gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 });
    const backgroundResult = background.catch((e: unknown) => e);
    await flush();
    void gate.generate('fg', {});
    await flush();
    expect(starts).toEqual(['bg', 'fg']);
    expect(await backgroundResult).toBeInstanceOf(OllamaPreemptedError);
  });

  it('does not leak the slot: the gate is idle once the foreground call finishes', async () => {
    const { client, settle, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    const background = gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 }).catch(() => undefined);
    await flush();
    const foreground = gate.generate('fg', {});
    await flush();
    settle[1]('done');
    await expect(foreground).resolves.toBe('done');
    await background;
    expect(gate.isIdle()).toBe(true);
    void gate.generate('next', {}, { queueTimeoutMs: 0 });
    await flush();
    expect(starts).toEqual(['bg', 'fg', 'next']);
  });

  it('a foreground call never preempts another foreground call', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    const first = gate.generate('a', {});
    await flush();
    void gate.generate('b', {});
    await flush();
    expect(starts).toEqual(['a']);
    expect(gate.isIdle()).toBe(false);
    void first;
  });

  it('a background waiter does not preempt a running background call', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    const first = gate.generate('bg1', {}, { background: true });
    await flush();
    void gate.generate('bg2', {}, { background: true });
    await flush();
    expect(starts).toEqual(['bg1']);
    void first;
  });

  it('a background waiter does not preempt a running foreground call', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    void gate.generate('fg', {});
    await flush();
    void gate.generate('bg', {}, { background: true });
    await flush();
    expect(starts).toEqual(['fg']);
  });

  it('keeps FIFO: the foreground waiter queued first gets the freed slot', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, config);
    void gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 }).catch(() => undefined);
    await flush();
    void gate.generate('fg1', {});
    void gate.generate('fg2', {});
    await flush();
    expect(starts).toEqual(['bg', 'fg1']);
  });

  it('with maxQueue 0, a foreground call preempts a running background call and runs', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 0 });
    const backgroundResult = gate
      .generate('bg', {}, { background: true, queueTimeoutMs: 0 })
      .catch((e: unknown) => e);
    await flush();
    expect(gate.isSaturated()).toBe(false);
    void gate.generate('fg', {});
    await flush();
    expect(starts).toEqual(['bg', 'fg']);
    expect(await backgroundResult).toBeInstanceOf(OllamaPreemptedError);
  });

  it('with maxQueue 0, a foreground call behind a running foreground call is still queue_full', async () => {
    const { client } = abortableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 0 });
    void gate.generate('fg1', {});
    await flush();
    expect(gate.isSaturated()).toBe(true);
    await expect(gate.generate('fg2', {})).rejects.toMatchObject({ reason: 'queue_full' });
  });

  it('a full queue does not stop a foreground call from preempting, and one prewarm is cancelled once', async () => {
    const { client, starts } = abortableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 1 });
    void gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 }).catch(() => undefined);
    await flush();
    void gate.generate('fg1', {});
    await flush();
    expect(starts).toEqual(['bg', 'fg1']);
    // fg1 now runs and the queue is empty, so a second foreground call queues normally.
    void gate.generate('fg2', {});
    await flush();
    expect(gate.isSaturated()).toBe(true);
    await expect(gate.generate('fg3', {})).rejects.toMatchObject({ reason: 'queue_full' });
  });

  it('isSaturated is false while only background calls run', async () => {
    const { client } = abortableClient();
    const gate = createOllamaGate(client, { ...config, maxQueue: 0 });
    void gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 }).catch(() => undefined);
    await flush();
    expect(gate.isSaturated()).toBe(false);
    expect(gate.isIdle()).toBe(false);
  });

  it('surfaces a non-preempted background failure unchanged', async () => {
    const { client } = controllableClient();
    const failing: OllamaClient = { generate: () => Promise.reject(new Error('model down')) };
    void client;
    const gate = createOllamaGate(failing, config);
    await expect(gate.generate('bg', {}, { background: true })).rejects.toThrow('model down');
    expect(gate.isIdle()).toBe(true);
  });
});

describe('createOllamaGate close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Inner client whose calls settle on demand and reject when their signal aborts. */
  function abortableClient(): { client: OllamaClient; settle: Array<(v: string) => void>; signals: Array<AbortSignal | undefined> } {
    const settle: Array<(v: string) => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const client: OllamaClient = {
      generate: (_prompt, _schema, options) =>
        new Promise<string>((resolve, reject) => {
          settle.push(resolve);
          signals.push(options?.signal);
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    return { client, settle, signals };
  }

  it('rejects queued waiters at once with shutting_down and clears their timers', async () => {
    const { client, settle } = abortableClient();
    const gate = createOllamaGate(client, config);
    const running = gate.generate('a', {});
    await flush();
    const queued = gate.generate('b', {}).catch((e: unknown) => e);
    await flush();
    gate.close();
    const error = await queued;
    expect(error).toBeInstanceOf(OllamaBusyError);
    expect((error as OllamaBusyError).reason).toBe('shutting_down');
    expect(vi.getTimerCount()).toBe(0);
    expect(settle).toHaveLength(1);
    settle[0]('done');
    await running;
    expect(settle).toHaveLength(1);
  });

  it('refuses new calls, including retries, and reports saturated', async () => {
    const { client, settle } = abortableClient();
    const gate = createOllamaGate(client, config);
    gate.close();
    expect(gate.isSaturated()).toBe(true);
    await expect(gate.generate('x', {})).rejects.toMatchObject({ reason: 'shutting_down' });
    await expect(gate.generate('y', {}, { background: true })).rejects.toMatchObject({ reason: 'shutting_down' });
    expect(settle).toHaveLength(0);
  });

  it('lets a running foreground call finish and release its slot', async () => {
    const { client, settle, signals } = abortableClient();
    const gate = createOllamaGate(client, config);
    const running = gate.generate('a', {});
    await flush();
    gate.close();
    expect(signals[0]).toBeUndefined();
    settle[0]('result');
    await expect(running).resolves.toBe('result');
    expect(gate.isIdle()).toBe(true);
  });

  it('aborts a running background call, which ends with shutting_down busy', async () => {
    const { client } = abortableClient();
    const gate = createOllamaGate(client, config);
    const bg = gate.generate('bg', {}, { background: true }).catch((e: unknown) => e);
    await flush();
    gate.close();
    const error = await bg;
    expect(error).toBeInstanceOf(OllamaBusyError);
    expect((error as OllamaBusyError).reason).toBe('shutting_down');
    expect(gate.isIdle()).toBe(true);
  });

  it('is idempotent', async () => {
    const { client } = abortableClient();
    const gate = createOllamaGate(client, config);
    gate.close();
    expect(() => gate.close()).not.toThrow();
    await expect(gate.generate('x', {})).rejects.toBeInstanceOf(OllamaBusyError);
  });

  it('close with a waiter that preempted a prewarm: the waiter is shutting_down, the prewarm stays preempted', async () => {
    const { client, signals } = abortableClient();
    const gate = createOllamaGate(client, config);
    const prewarm = gate.generate('bg', {}, { background: true, queueTimeoutMs: 0 }).catch((e: unknown) => e);
    await flush();
    // The waiter cancels the prewarm but has not been handed the slot yet.
    const waiter = gate.generate('fg', {}).catch((e: unknown) => e);
    gate.close();
    const waiterError = await waiter;
    const prewarmError = await prewarm;
    expect(waiterError).toBeInstanceOf(OllamaBusyError);
    expect((waiterError as OllamaBusyError).reason).toBe('shutting_down');
    expect(prewarmError).toBeInstanceOf(OllamaPreemptedError);
    expect(signals).toHaveLength(1);
    expect(gate.isIdle()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
