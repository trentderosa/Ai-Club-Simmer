import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  createCorsMiddleware,
} from './cors.js';
import { DEFAULT_ALLOWED_ORIGINS, parseAllowedOrigins } from '../config.js';

const ALLOWED = 'http://localhost:8081';
const ALSO_ALLOWED = 'http://127.0.0.1:19006';
const DISALLOWED = 'http://evil.example';

function createApp(origins: readonly string[] = DEFAULT_ALLOWED_ORIGINS): express.Express {
  const app = express();
  app.use(createCorsMiddleware(origins));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.post('/api/check-ins', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('CORS middleware', () => {
  it('echoes an allowed Origin and sets Vary: Origin', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('Origin', ALLOWED);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['vary']).toMatch(/Origin/i);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('exposes Retry-After (not *) to an allowed origin', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('Origin', ALLOWED);

    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('does not expose any headers to a disallowed origin', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('Origin', DISALLOWED);

    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('gives a disallowed Origin no CORS allow headers; the request still runs', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('Origin', DISALLOWED);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['vary']).toMatch(/Origin/i);
  });

  it('answers OPTIONS preflight for an allowed origin with the client headers and methods', async () => {
    const res = await request(createApp())
      .options('/api/check-ins')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type, Idempotency-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['vary']).toMatch(/Origin/i);
    const methods = String(res.headers['access-control-allow-methods'] ?? '');
    for (const method of CORS_ALLOWED_METHODS) {
      expect(methods).toContain(method);
    }
    const headers = String(res.headers['access-control-allow-headers'] ?? '');
    for (const header of CORS_ALLOWED_HEADERS) {
      expect(headers.toLowerCase()).toContain(header.toLowerCase());
    }
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.body).toEqual({});
  });

  it('gives a disallowed preflight no CORS allow headers', async () => {
    const res = await request(createApp())
      .options('/api/check-ins')
      .set('Origin', DISALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type');

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('uses the Expo dev/web defaults when the middleware is given the default list', async () => {
    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      const res = await request(createApp(DEFAULT_ALLOWED_ORIGINS))
        .get('/health')
        .set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
    // A second default origin (legacy Expo web on 127.0.0.1) also works.
    const res = await request(createApp(DEFAULT_ALLOWED_ORIGINS))
      .post('/api/check-ins')
      .set('Origin', ALSO_ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALSO_ALLOWED);
  });

  it('echoes the GitHub Pages origin when ALLOWED_ORIGINS lists it', async () => {
    const pagesOrigin = 'https://trentderosa.github.io';
    const origins = parseAllowedOrigins({
      ALLOWED_ORIGINS: `http://localhost:8081, ${pagesOrigin}`,
    });
    const res = await request(createApp(origins))
      .options('/api/check-ins')
      .set('Origin', pagesOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type, Idempotency-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(pagesOrigin);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['vary']).toMatch(/Origin/i);
  });

  it('does not allow the GitHub Pages origin unless ALLOWED_ORIGINS lists it', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('Origin', 'https://trentderosa.github.io');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(DEFAULT_ALLOWED_ORIGINS).not.toContain('https://trentderosa.github.io');
  });

  it('adds no Allow-Origin when the request has no Origin header', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
