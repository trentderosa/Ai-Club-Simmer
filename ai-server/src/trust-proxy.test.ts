import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { applyTrustProxy } from './trust-proxy.js';

const SPOOFED = '203.0.113.8';
const LAN_PEER = '192.168.1.50';

function ipApp(peer: string | null): express.Express {
  const app = express();
  applyTrustProxy(app, 'true');
  if (peer !== null) {
    app.use((req: Request, _res: Response, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: peer,
      });
      next();
    });
  }
  app.get('/ip', (req: Request, res: Response) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('loopback trust proxy', () => {
  it('uses X-Forwarded-For when the direct peer is the local tunnel', async () => {
    const res = await request(ipApp(null)).get('/ip').set('X-Forwarded-For', SPOOFED);
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(SPOOFED);
  });

  it('does not let a direct non-loopback peer spoof req.ip', async () => {
    const res = await request(ipApp(LAN_PEER)).get('/ip').set('X-Forwarded-For', SPOOFED);
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(LAN_PEER);
    expect(res.body.ip).not.toBe(SPOOFED);
  });
});
