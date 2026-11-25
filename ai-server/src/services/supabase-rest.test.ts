import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { SupabaseRest, SupabaseRestError, httpFailureMessage, parseJsonText, postgrestCode, readJson } from './supabase-rest.js';

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
    expect(error.message).toBe('Supabase rpc fn request failed: invalid JSON response');
    // Node's SyntaxError quotes the body, so it is not kept as the cause either.
    expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain('not json');
  });
});

describe('SupabaseRestError body handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const body = '{"code":"23505","message":"duplicate key","details":"Key (email)=(cook@simmer.invalid) already exists"}';

  it('keeps the status and Postgres code in the message but never the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, text: () => Promise.resolve(body) }));
    const error = await failure(new SupabaseRest(config).rpc('fn', {}));
    expect(error.message).toBe('Supabase rpc fn failed: 409 (23505)');
    expect(error.pgCode).toBe('23505');
    expect(error.body).toBe(body);
  });

  it('does not print the body when the error object itself is logged', () => {
    const error = SupabaseRestError.fromResponse('Supabase rpc fn failed', 409, body);
    expect(Object.keys(error)).not.toContain('body');
    expect(JSON.stringify(error)).not.toContain('cook@simmer.invalid');
    expect(inspect(error)).not.toContain('cook@simmer.invalid');
  });

  it('ignores a body code that is not a plain PostgREST/Postgres code', () => {
    expect(postgrestCode('{"code":"see cook@simmer.invalid"}')).toBeUndefined();
    expect(postgrestCode('not json')).toBeUndefined();
    expect(postgrestCode('{"code":"PGRST202"}')).toBe('PGRST202');
    expect(httpFailureMessage('x failed', 500, 'oops')).toBe('x failed: 500');
  });
});

describe('readJson', () => {
  it('turns a SyntaxError into a body-free invalid_response error', async () => {
    const response = {
      status: 200,
      json: (): Promise<unknown> => Promise.resolve().then(() => JSON.parse('cook@simmer.invalid') as unknown),
    };
    const error = await failure(readJson(response, 'Supabase check-in read'));
    expect(error.message).toBe('Supabase check-in read: invalid JSON response');
    expect(error.kind).toBe('invalid_response');
    expect(error.status).toBe(200);
    expect(inspect(error)).not.toContain('cook@simmer.invalid');
  });

  it('returns parsed JSON and passes other errors through', async () => {
    await expect(readJson({ status: 200, json: () => Promise.resolve([1]) }, 'x')).resolves.toEqual([1]);
    const boom = new TypeError('body already used');
    await expect(readJson({ status: 200, json: () => Promise.reject(boom) }, 'x')).rejects.toBe(boom);
  });
});

describe('parseJsonText', () => {
  it('turns a SyntaxError into a body-free invalid_response error', () => {
    let error: unknown;
    try {
      parseJsonText('<html>cook@simmer.invalid</html>', 'Supabase generated recipe read failed', 200);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SupabaseRestError);
    const restError = error as SupabaseRestError;
    expect(restError.message).toBe('Supabase generated recipe read failed: invalid JSON response');
    expect(restError.kind).toBe('invalid_response');
    expect(restError.status).toBe(200);
    expect(inspect(restError)).not.toContain('cook@simmer.invalid');
  });

  it('returns parsed JSON', () => {
    expect(parseJsonText<number[]>('[1]', 'x', 200)).toEqual([1]);
  });
});
