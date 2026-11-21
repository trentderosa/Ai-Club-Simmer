import type { Express } from 'express';

/**
 * Express `trust proxy` value when TRUST_PROXY=true.
 * X-Forwarded-For is used only when the direct peer is loopback (the tunnel
 * on this laptop). A client that connects from the LAN cannot set req.ip.
 */
export const LOOPBACK_TRUST_PROXY = 'loopback';

export function applyTrustProxy(app: Express, trustProxy: string | undefined): void {
  if (trustProxy === 'true') {
    app.set('trust proxy', LOOPBACK_TRUST_PROXY);
  }
}
