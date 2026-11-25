import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRest, SupabaseRestError } from './supabase-rest.js';

const config = { url: 'https://db.simmer.invalid', serviceRoleKey: 'test-service-role', timeoutMs: 100 };

async function failure(promise: Promise<unknown>): Promise<SupabaseRestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupabaseRestError);
    return error as SupabaseRestError;
  }
  throw new Error('expected a SupabaseRestError');
}

describe('SupabaseRestError kind', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks a non-2xx response as http with its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('upstream down') })
    );
    const error = await failure(new SupabaseRest(config).rpc('fn', {}));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(503);
  });

  it('marks an aborted request as timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      )
    );
    const error = await failure(new SupabaseRest({ ...config, timeoutMs: 5 }).rpc('fn', {}));
    expect(error.kind).toBe('timeout');
    expect(error.status).toBeUndefined();
  });

  it('marks a fetch failure as network and keeps the cause', async () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));
    const error = await failure(new SupabaseRest(config).rpc('fn', {}));
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(fetchError);
  });

  it('marks an unparseable 200 body as invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('not json') })
    );
    const error = await failure(new SupabaseRest(config).rpc('fn', {}));
    expect(error.kind).toBe('invalid_response');
  });
});
