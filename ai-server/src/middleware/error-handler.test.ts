import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCorsMiddleware } from './cors.js';
import { mountErrorHandlers } from './error-handler.js';

const ORIGIN = 'http://localhost:8081';

function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(createCorsMiddleware([ORIGIN]));
  app.use(express.json());
  app.post('/echo', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/boom', () => {
    throw new Error('secret-token-abc leaked in message');
  });
  app.get('/late', (_req, res, next) => {
    res.write('partial');
    next(new Error('after headers'));
  });
  mountErrorHandlers(app);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error handlers', () => {
  it('returns 400 JSON for malformed JSON', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Request body is not valid JSON', code: 'INVALID_JSON' });
  });

  it('returns 413 JSON for an oversize body', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
  });

  it('returns 500 JSON without stack or message, and logs only name and message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get('/boom').set('Authorization', 'Bearer top-secret');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(res.text).not.toContain('secret-token-abc');
    expect(res.text).not.toContain('at ');
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('Error: secret-token-abc');
    expect(logged).not.toContain('top-secret');
    expect(logged).not.toContain('.ts:');
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('keeps CORS headers on a 400 from an allowed origin', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('does not send X-Powered-By', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('delegates to the default handler when headers were already sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get('/late').catch((e: unknown) => e);
    // The default handler destroys the socket; either way no JSON 500 is appended.
    const text = res instanceof Error ? '' : (res as request.Response).text;
    expect(text).not.toContain('Internal server error');
  });
});
