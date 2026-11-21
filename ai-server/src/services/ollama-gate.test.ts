import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaClient } from './ollama-client.js';
import { createOllamaGate, OllamaBusyError } from './ollama-gate.js';

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
