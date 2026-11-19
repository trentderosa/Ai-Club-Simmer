import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  DEEP_HEALTH_CACHE_TTL_MS,
  mountHealthRoutes,
  runDeepHealthCheck,
  type DeepHealthDeps,
} from './health.js';

const SERVICE_ROLE = 'service-role-secret-value';
const YOUTUBE_KEY = 'youtube-key-secret-value';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const SUPABASE_URL = 'https://example.supabase.co';

function deps(fetchImpl: DeepHealthDeps['fetchImpl'], overrides: Partial<DeepHealthDeps> = {}): DeepHealthDeps {
  return {
    ollamaBaseUrl: OLLAMA_URL,
    ollamaModel: 'llama3.2',
    supabaseUrl: SUPABASE_URL,
    supabaseServiceRoleKey: SERVICE_ROLE,
    youtubeApiKey: YOUTUBE_KEY,
    timeoutMs: 50,
    fetchImpl,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okFetch(): typeof fetch {
  return vi.fn((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes('/api/tags')) {
      return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:latest' }] }));
    }
    if (url.includes('/rest/v1/path_slots')) {
      return Promise.resolve(jsonResponse([{ id: 1 }]));
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }) as typeof fetch;
}

function fetchCalls(fetchImpl: typeof fetch): [string, RequestInit?][] {
  return (fetchImpl as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
}

function hangUntilAborted(_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'TimeoutError'));
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /health', () => {
  it('stays fast and does not call dependencies', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.timestamp).toBe('string');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('GET /health/deep', () => {
  it('reports ok when Ollama has the model, Supabase answers, and the YouTube key is set', async () => {
    const fetchImpl = okFetch();
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const response = await request(app).get('/health/deep');
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      checks: {
        ollama: { status: 'ok' },
        supabase: { status: 'ok' },
        youtube: { status: 'ok' },
      },
    });
    expect(body).not.toContain(SERVICE_ROLE);
    expect(body).not.toContain(YOUTUBE_KEY);
    expect(body).not.toContain(OLLAMA_URL);
    expect(body).not.toContain(SUPABASE_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchCalls(fetchImpl).map((call) => call[0]);
    expect(urls.some((url) => url.includes('googleapis.com'))).toBe(false);
    const supabaseCall = fetchCalls(fetchImpl).find((call) => call[0].includes('/rest/v1/path_slots'));
    expect(supabaseCall?.[1]?.headers).toMatchObject({
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    });
  });

  it('returns 503 when a check fails and does not leak secrets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaked = `connect ECONNREFUSED ${OLLAMA_URL}/api/tags key=${SERVICE_ROLE}`;
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.reject(new Error(leaked));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));
    const response = await request(app).get('/health/deep');
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'fail',
      checks: {
        ollama: { status: 'fail', reason: 'unreachable' },
        supabase: { status: 'ok' },
        youtube: { status: 'ok' },
      },
    });
    expect(body).not.toContain(leaked);
    expect(body).not.toContain(SERVICE_ROLE);
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain(OLLAMA_URL);
    expect(warn).toHaveBeenCalledWith(
      'health_deep_failed',
      expect.objectContaining({ ollama: 'unreachable' })
    );
  });

  it('reuses the cached report within the TTL so two calls hit upstream only once', async () => {
    const fetchImpl = okFetch();
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const first = await request(app).get('/health/deep');
    const second = await request(app).get('/health/deep');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refreshes the report after the TTL expires', async () => {
    vi.useFakeTimers();
    const fetchImpl = okFetch();
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const first = await request(app).get('/health/deep');
    expect(first.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DEEP_HEALTH_CACHE_TTL_MS - 1);
    const cached = await request(app).get('/health/deep');
    expect(cached.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await request(app).get('/health/deep');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toEqual(first.body);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent calls onto one in-flight check', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      await gate;
      const url = String(input);
      if (url.includes('/api/tags')) {
        return jsonResponse({ models: [{ name: 'llama3.2:latest' }] });
      }
      if (url.includes('/rest/v1/path_slots')) {
        return jsonResponse([{ id: 1 }]);
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const pending = Promise.all([request(app).get('/health/deep'), request(app).get('/health/deep')]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    release();

    const [a, b] = await pending;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a path on the Ollama or Supabase base URL', async () => {
    const fetchImpl = okFetch();
    const ollamaBaseUrl = 'http://127.0.0.1:11434/ollama';
    const supabaseUrl = 'https://example.supabase.co/prefix';
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl, { ollamaBaseUrl, supabaseUrl }));

    const response = await request(app).get('/health/deep');
    const urls = fetchCalls(fetchImpl).map((call) => call[0]);

    expect(response.status).toBe(200);
    expect(urls).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:11434/ollama/api/tags',
        'https://example.supabase.co/prefix/rest/v1/path_slots?select=id&limit=1',
      ])
    );
    expect(urls.some((url) => url === 'http://127.0.0.1:11434/api/tags')).toBe(false);
    expect(urls.some((url) => url.startsWith('https://example.supabase.co/rest/v1/path_slots'))).toBe(false);
  });

  it('reports fail when Ollama is down and does not echo the error', async () => {
    const leaked = `connect ECONNREFUSED ${OLLAMA_URL}/api/tags key=${SERVICE_ROLE}`;
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.reject(new Error(leaked));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const report = await runDeepHealthCheck(deps(fetchImpl));
    const body = JSON.stringify(report);

    expect(report.status).toBe('fail');
    expect(report.checks.ollama).toEqual({ status: 'fail', reason: 'unreachable' });
    expect(report.checks.supabase).toEqual({ status: 'ok' });
    expect(report.checks.youtube).toEqual({ status: 'ok' });
    expect(body).not.toContain(leaked);
    expect(body).not.toContain(SERVICE_ROLE);
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('Error');
  });

  it('reports fail when Supabase is down and does not echo the body', async () => {
    const leaked = `permission denied for ${SUPABASE_URL} ${SERVICE_ROLE}`;
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:latest' }] }));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(new Response(leaked, { status: 500 }));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const report = await runDeepHealthCheck(deps(fetchImpl));
    const body = JSON.stringify(report);

    expect(report.status).toBe('fail');
    expect(report.checks.ollama).toEqual({ status: 'ok' });
    expect(report.checks.supabase).toEqual({ status: 'fail', reason: 'unreachable' });
    expect(report.checks.youtube).toEqual({ status: 'ok' });
    expect(body).not.toContain(leaked);
    expect(body).not.toContain(SERVICE_ROLE);
    expect(body).not.toContain(SUPABASE_URL);
  });

  it('reports timeout when a dependency fetch never resolves', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return hangUntilAborted(input, init);
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const report = await runDeepHealthCheck(deps(fetchImpl));

    expect(report.status).toBe('fail');
    expect(report.checks.ollama).toEqual({ status: 'fail', reason: 'timeout' });
    expect(report.checks.supabase).toEqual({ status: 'ok' });
    expect(report.checks.youtube).toEqual({ status: 'ok' });
  });

  it('reports model_missing when the configured model is not listed', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'other-model:latest' }] }));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const report = await runDeepHealthCheck(deps(fetchImpl));

    expect(report.status).toBe('fail');
    expect(report.checks.ollama).toEqual({ status: 'fail', reason: 'model_missing' });
    expect(report.checks.supabase).toEqual({ status: 'ok' });
    expect(report.checks.youtube).toEqual({ status: 'ok' });
  });

  it('reports the YouTube key as skipped and the overall status as degraded', async () => {
    for (const youtubeApiKey of [undefined, '', '   ']) {
      const report = await runDeepHealthCheck(deps(okFetch(), { youtubeApiKey }));
      const body = JSON.stringify(report);

      expect(report.status).toBe('degraded');
      expect(report.checks.ollama).toEqual({ status: 'ok' });
      expect(report.checks.supabase).toEqual({ status: 'ok' });
      expect(report.checks.youtube).toEqual({ status: 'skipped', reason: 'not_configured' });
      expect(body).not.toContain(SERVICE_ROLE);
      expect(body).not.toContain(YOUTUBE_KEY);
    }
  });

  it('returns HTTP 200 when only the YouTube key is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = okFetch();
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl, { youtubeApiKey: undefined }));

    const response = await request(app).get('/health/deep');
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'degraded',
      checks: {
        ollama: { status: 'ok' },
        supabase: { status: 'ok' },
        youtube: { status: 'skipped', reason: 'not_configured' },
      },
    });
    expect(body).not.toContain(SERVICE_ROLE);
    expect(body).not.toContain(OLLAMA_URL);
    expect(body).not.toContain(SUPABASE_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchCalls(fetchImpl).map((call) => call[0]);
    expect(urls.some((url) => url.includes('googleapis.com'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'health_deep_degraded',
      expect.objectContaining({ youtube: 'not_configured', ollama: 'ok', supabase: 'ok' })
    );
  });

  it('still fails the endpoint when Ollama is down and the YouTube key is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.reject(new Error('ollama down'));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const app = express();
    mountHealthRoutes(app, deps(fetchImpl, { youtubeApiKey: undefined }));
    const response = await request(app).get('/health/deep');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'fail',
      checks: {
        ollama: { status: 'fail', reason: 'unreachable' },
        supabase: { status: 'ok' },
        youtube: { status: 'skipped', reason: 'not_configured' },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('ollama down');
    expect(warn).toHaveBeenCalledWith(
      'health_deep_failed',
      expect.objectContaining({ ollama: 'unreachable', youtube: 'not_configured' })
    );
  });

  it('caches a degraded report for the same TTL and does not call YouTube', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = okFetch();
    const app = express();
    mountHealthRoutes(app, deps(fetchImpl, { youtubeApiKey: undefined }));

    const first = await request(app).get('/health/deep');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('degraded');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DEEP_HEALTH_CACHE_TTL_MS - 1);
    const cached = await request(app).get('/health/deep');
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual(first.body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await request(app).get('/health/deep');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.status).toBe('degraded');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const urls = fetchCalls(fetchImpl).map((call) => call[0]);
    expect(urls.some((url) => url.includes('googleapis.com'))).toBe(false);
  });

  it('expires a failed report after the same TTL', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.reject(new Error('down'));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const app = express();
    mountHealthRoutes(app, deps(fetchImpl));

    const first = await request(app).get('/health/deep');
    expect(first.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DEEP_HEALTH_CACHE_TTL_MS);
    const refreshed = await request(app).get('/health/deep');
    expect(refreshed.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('reports unreachable when Ollama returns a non-JSON body', async () => {
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return Promise.resolve(new Response('<html>ok</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
      }
      if (url.includes('/rest/v1/path_slots')) {
        return Promise.resolve(jsonResponse([{ id: 1 }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as typeof fetch;

    const report = await runDeepHealthCheck(deps(fetchImpl));

    expect(report.status).toBe('fail');
    expect(report.checks.ollama).toEqual({ status: 'fail', reason: 'unreachable' });
    expect(report.checks.supabase).toEqual({ status: 'ok' });
    expect(report.checks.youtube).toEqual({ status: 'ok' });
    expect(JSON.stringify(report)).not.toContain('<html>');
  });
});
