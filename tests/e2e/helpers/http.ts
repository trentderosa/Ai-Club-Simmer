// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface HttpResult {
  status: number;
  body: Json;
  headers: Headers;
  ms: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch + JSON parse + timing. Error messages never include request headers. */
export async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<HttpResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 240_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: Json = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, body, headers: res.headers, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
