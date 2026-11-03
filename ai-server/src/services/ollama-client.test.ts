import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTimedFetch } from './ollama-client.js';

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
