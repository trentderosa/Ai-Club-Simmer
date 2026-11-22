import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPreAuthIpLimiter } from './pre-auth-ip-limiter.js';

function appWith(limiter: express.RequestHandler): express.Express {
  const app = express();
  app.get('/', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createPreAuthIpLimiter', () => {
  it('returns 429 with the standard message past the cap', async () => {
    const app = appWith(createPreAuthIpLimiter({ windowMs: 60000, maxRequests: 2 }));
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    const res = await request(app).get('/');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests, please try again later' });
  });

  it('uses the default cap of 60 when no options are given', async () => {
    const app = appWith(createPreAuthIpLimiter());
    const res = await request(app).get('/');
    expect(res.headers['ratelimit-limit']).toBe('60');
  });

  it('does not share counts between instances', async () => {
    const a = appWith(createPreAuthIpLimiter({ windowMs: 60000, maxRequests: 1 }));
    const b = appWith(createPreAuthIpLimiter({ windowMs: 60000, maxRequests: 1 }));
    expect((await request(a).get('/')).status).toBe(200);
    expect((await request(a).get('/')).status).toBe(429);
    expect((await request(b).get('/')).status).toBe(200);
  });
});
