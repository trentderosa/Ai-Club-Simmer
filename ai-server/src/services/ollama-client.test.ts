import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOllamaClient, createTimedFetch } from './ollama-client.js';

describe('createTimedFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes AbortSignal.timeout to fetch init', async () => {
    const timeoutMs = 5000;
    const timedFetch = createTimedFetch(timeoutMs);

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await timedFetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:11434/api/chat');

    const init = callArgs[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves original init options when adding signal', async () => {
    const timeoutMs = 5000;
    const timedFetch = createTimedFetch(timeoutMs);

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await timedFetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
      body: '{"test": true}',
    });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"test": true}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
    expect((init.headers as Record<string, string>)['X-Custom']).toBe('value');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('allows successful requests to complete', async () => {
    const timeoutMs = 5000;
    const timedFetch = createTimedFetch(timeoutMs);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":{"content":"test"}}', { status: 200 })
    );

    const response = await timedFetch('http://localhost:11434/api/chat');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: { content: string } };
    expect(body.message.content).toBe('test');
  });

  it('rejects when fetch rejects due to abort signal', async () => {
    const timeoutMs = 5000;
    const timedFetch = createTimedFetch(timeoutMs);

    // Simulate fetch rejecting due to abort (what happens when signal times out)
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(timedFetch('http://localhost:11434/api/chat')).rejects.toThrow(
      'aborted'
    );
  });

  it('wraps fetch with the configured timeout value', () => {
    const timeoutMs = 30000;
    const timedFetch = createTimedFetch(timeoutMs);

    // The returned function should be a valid fetch replacement
    expect(typeof timedFetch).toBe('function');
  });
});

describe('external abort signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Fake fetch that stays pending until its signal aborts, then rejects. */
  function hangingFetch(): { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    return { signals };
  }

  it('createTimedFetch aborts when the caller signal aborts', async () => {
    const { signals } = hangingFetch();
    const controller = new AbortController();
    const pending = createTimedFetch(5000, controller.signal)('http://localhost:11434/api/chat');
    expect(signals[0].aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(signals[0].aborted).toBe(true);
  });

  it('createTimedFetch rejects at once when the caller signal is already aborted', async () => {
    hangingFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(createTimedFetch(5000, controller.signal)('http://localhost:11434/api/chat')).rejects.toThrow();
  });

  it('createTimedFetch still times out with a caller signal that never aborts', async () => {
    vi.useFakeTimers();
    const { signals } = hangingFetch();
    const controller = new AbortController();
    const pending = createTimedFetch(50, controller.signal)('http://localhost:11434/api/chat');
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60);
    expect(await settled).toBeInstanceOf(DOMException);
    expect(signals[0].aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it('the fallback combiner works when AbortSignal.any is missing', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error simulate Node 18
    AbortSignal.any = undefined;
    try {
      const { signals } = hangingFetch();
      const controller = new AbortController();
      const pending = createTimedFetch(5000, controller.signal)('http://localhost:11434/api/chat');
      controller.abort();
      await expect(pending).rejects.toThrow('aborted');
      expect(signals[0].aborted).toBe(true);
    } finally {
      AbortSignal.any = original;
    }
  });

  it('createOllamaClient.generate: the ollama-js request sees the abort', async () => {
    const { signals } = hangingFetch();
    const client = createOllamaClient({ baseUrl: 'http://localhost:11434', model: 'm', maxTokens: 10, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = client.generate('p', {}, { signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(signals[0].aborted).toBe(true);
  });

  it('createOllamaClient.generate: the timeout still aborts without a signal', async () => {
    vi.useFakeTimers();
    const { signals } = hangingFetch();
    const client = createOllamaClient({ baseUrl: 'http://localhost:11434', model: 'm', maxTokens: 10, timeoutMs: 50 });
    const pending = client.generate('p', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeInstanceOf(Error);
    expect(signals[0].aborted).toBe(true);
  });
});
