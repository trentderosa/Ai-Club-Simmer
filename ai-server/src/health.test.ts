import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountHealthRoutes, runDeepHealthCheck, type DeepHealthDeps } from './health.js';

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
    const urls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.map(
      (call) => call[0]
    );
    expect(urls.some((url) => url.includes('googleapis.com'))).toBe(false);
    const supabaseCall = (fetchImpl as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(
      (call) => call[0].includes('/rest/v1/path_slots')
    );
    expect(supabaseCall?.[1]?.headers).toMatchObject({
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    });
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
});
