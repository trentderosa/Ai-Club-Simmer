import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from './authenticate.js';
import { createMockJwtVerifier } from '../test-utils/mock-jwt-verifier.js';
import type { JwtVerifier, JwtVerifyResult } from '../services/jwt-verifier.js';

const FAKE_TOKEN = 'fake-token-abc123';
const FAKE_USER_ID = 'user-1@simmer.invalid';

function verifierReturning(result: JwtVerifyResult): JwtVerifier {
  return { verify: vi.fn().mockResolvedValue(result) };
}

function createApp(verifier: JwtVerifier): express.Express {
  const app = express();
  const auth = createAuthMiddleware(verifier);
  app.get('/protected', (req, res, next) => void auth(req, res, next), (req, res) => {
    res.status(200).json({ userId: req.userId });
  });
  return app;
}

describe('authenticate middleware', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const verifier = verifierReturning({ valid: true, userId: FAKE_USER_ID });
    const res = await request(createApp(verifier)).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid authorization header' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['Basic scheme', `Basic ${FAKE_TOKEN}`],
    ['lowercase bearer', `bearer ${FAKE_TOKEN}`],
    ['no scheme', FAKE_TOKEN],
    ['Bearer without space', `Bearer${FAKE_TOKEN}`],
  ])('returns 401 for a malformed header (%s) without echoing the token', async (_name, header) => {
    const verifier = verifierReturning({ valid: true, userId: FAKE_USER_ID });
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', header);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid authorization header' });
    expect(res.text).not.toContain(FAKE_TOKEN);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  // Hand-built req/res (instead of supertest) lets us check next() args, that res.status is
  // not called, and the trailing-space 'Bearer ' case that HTTP clients strip.
  it('passes an empty token to the verifier and returns 401', async () => {
    const verifier = createMockJwtVerifier(new Map([[FAKE_TOKEN, FAKE_USER_ID]]));
    const spy = vi.spyOn(verifier, 'verify');
    const middleware = createAuthMiddleware(verifier);
    const req = { headers: { authorization: 'Bearer ' } } as express.Request;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as express.Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(spy).toHaveBeenCalledWith('');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 "Invalid or expired token" for an unknown token and does not echo it', async () => {
    const verifier = createMockJwtVerifier(new Map([[FAKE_TOKEN, FAKE_USER_ID]]));
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', 'Bearer some-other-fake-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
    expect(res.text).not.toContain('some-other-fake-token');
  });

  it('returns 401 "Token expired" when the verifier reports expiry', async () => {
    const verifier = verifierReturning({ valid: false, error: 'expired' });
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Token expired' });
    expect(res.text).not.toContain(FAKE_TOKEN);
  });

  it('returns 401 when the token is valid but has no user id', async () => {
    const verifier = verifierReturning({ valid: true });
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns 401 for no_user_id errors', async () => {
    const verifier = verifierReturning({ valid: false, error: 'no_user_id' });
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns 503 AUTH_UNAVAILABLE when the verifier service is unavailable', async () => {
    const verifier = verifierReturning({ valid: false, error: 'service_unavailable' });
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Authentication service unavailable',
      code: 'AUTH_UNAVAILABLE',
    });
    expect(res.text).not.toContain(FAKE_TOKEN);
  });

  it('sets req.userId, calls next, and passes the bare token to the verifier', async () => {
    const verifier = createMockJwtVerifier(new Map([[FAKE_TOKEN, FAKE_USER_ID]]));
    const spy = vi.spyOn(verifier, 'verify');
    const res = await request(createApp(verifier))
      .get('/protected')
      .set('Authorization', `Bearer ${FAKE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: FAKE_USER_ID });
    expect(spy).toHaveBeenCalledWith(FAKE_TOKEN);
  });

  it('calls next() with no arguments and does not respond itself on success', async () => {
    const verifier = verifierReturning({ valid: true, userId: FAKE_USER_ID });
    const middleware = createAuthMiddleware(verifier);
    const req = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } } as express.Request;
    const res = { status: vi.fn(), json: vi.fn() } as unknown as express.Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe(FAKE_USER_ID);
  });

  it('does not call next or set userId on failure', async () => {
    const verifier = verifierReturning({ valid: false, error: 'invalid_token' });
    const middleware = createAuthMiddleware(verifier);
    const req = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } } as express.Request;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as express.Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.userId).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // Today a throwing verifier surfaces as an unhandled rejection; the real verifier in
  // services/jwt-verifier.ts catches everything, so only custom verifiers can reach this.
  it('fails closed when the verifier throws', async () => {
    const verifier: JwtVerifier = { verify: vi.fn().mockRejectedValue(new Error('boom')) };
    const middleware = createAuthMiddleware(verifier);
    const req = { headers: { authorization: `Bearer ${FAKE_TOKEN}` } } as express.Request;
    const res = { status: vi.fn(), json: vi.fn() } as unknown as express.Response;
    const next = vi.fn();

    await middleware(req, res, next).catch(() => {});
    expect(next).not.toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });
});
