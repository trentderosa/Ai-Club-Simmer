import { env } from './env.js';
import { request, sleep, type HttpResult } from './http.js';

export interface AiOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  /** Wait and retry on 429 (the server's own per-IP / per-user limits). Default true. */
  retry429?: boolean;
  rawAuthHeader?: string;
}

export interface AiResult extends HttpResult {
  attempts: number;
}

/**
 * Calls the AI server like the app does. 429 is documented behaviour, so by
 * default we back off and retry (up to ~2 minutes); pass retry429: false to see it.
 */
export async function ai(path: string, opts: AiOptions = {}): Promise<AiResult> {
  const headers: Record<string, string> = {};
  if (opts.rawAuthHeader !== undefined) headers.Authorization = opts.rawAuthHeader;
  else if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const res = await request(`${env().aiUrl}${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body ?? (opts.method === 'GET' ? undefined : {}),
    });
    if (res.status === 429 && opts.retry429 !== false && attempts < 9) {
      await sleep(15_000);
      continue;
    }
    return { ...res, attempts };
  }
}

export const generateSlot = (token: string, slotId: number | string) =>
  ai(`/api/recipes/generate/${slotId}`, { token });

export const cookAnything = (token: string, dish: unknown, retry429 = true) =>
  ai('/api/recipes/cook-anything', { token, body: { dish }, retry429 });

export const postCheckIn = (token: string, body: Record<string, unknown>, retry429 = true) =>
  ai('/api/check-ins', { token, body, retry429 });
