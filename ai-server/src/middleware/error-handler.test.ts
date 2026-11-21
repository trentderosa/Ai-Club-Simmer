import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCorsMiddleware } from './cors.js';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler, mountErrorHandlers } from './error-handler.js';

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

function fakeNext(): NextFunction & ReturnType<typeof vi.fn> {
  return vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
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

  it('returns 500 JSON without stack or message, and logs only the error name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get('/boom').set('Authorization', 'Bearer top-secret');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(res.text).not.toContain('secret-token-abc');
    expect(res.text).not.toContain('at ');
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('Unhandled error: Error');
    expect(logged).not.toContain('secret-token-abc');
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

  it('returns 415 JSON for an unsupported charset and does not log it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json; charset=latin1')
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported request encoding', code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 415 JSON for an unsupported Content-Encoding', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'bogus')
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported request encoding', code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps other exposable 4xx errors to a generic 400 body without logging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const json = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json } as unknown as Response;
    const err = Object.assign(new Error('request aborted'), { status: 400, expose: true, type: 'request.aborted' });
    errorHandler(err, {} as Request, res, fakeNext());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Bad request', code: 'BAD_REQUEST' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a 4xx without expose=true as an unhandled 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const json = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json } as unknown as Response;
    errorHandler(Object.assign(new Error('x'), { status: 400 }), {} as Request, res, fakeNext());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('logs a string error code but not the message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    errorHandler(Object.assign(new Error('https://x/?token=abc'), { code: 'ECONNRESET' }), {} as Request, res, fakeNext());
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('token=abc');
  });

  it('delegates to next(err) without writing when headers were already sent', () => {
    const err = new Error('after headers');
    const next = fakeNext();
    const status = vi.fn();
    const json = vi.fn();
    const res = { headersSent: true, status, json } as unknown as Response;
    errorHandler(err, {} as Request, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('does not append a JSON 500 to a response that already started', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get('/late').catch((e: unknown) => e);
    const text = res instanceof Error ? '' : (res as request.Response).text;
    expect(text).not.toContain('Internal server error');
  });

  it('does not shadow routes registered before the error handlers', async () => {
    const app = express();
    const router = express.Router();
    router.get('/ping', (_req, res) => {
      res.json({ pong: true });
    });
    app.use('/api/sample', router);
    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
    mountErrorHandlers(app);
    const a = await request(app).get('/api/sample/ping');
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ pong: true });
    const b = await request(app).get('/health');
    expect(b.status).toBe(200);
    expect((await request(app).get('/api/sample/missing')).status).toBe(404);
  });
});
