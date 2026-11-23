import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { PREAUTH_IP_RATE_LIMIT_MAX, PREAUTH_IP_RATE_LIMIT_WINDOW_MS } from '../config.js';

export interface PreAuthIpLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

/**
 * Per-IP limiter for routes that verify tokens, mounted BEFORE auth so
 * unauthenticated floods are bounded. Each call makes a new limiter with its
 * own store, so routers do not share counts. Behind a reverse proxy set
 * TRUST_PROXY=true so req.ip is the real client. Looser than the per-user cap
 * because many students can share one NAT or tunnel IP. Fallbacks are the
 * config defaults.
 */
export function createPreAuthIpLimiter(opts?: Partial<PreAuthIpLimiterOptions>): RequestHandler {
  return rateLimit({
    windowMs: opts?.windowMs ?? PREAUTH_IP_RATE_LIMIT_WINDOW_MS.default,
    max: opts?.maxRequests ?? PREAUTH_IP_RATE_LIMIT_MAX.default,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}
