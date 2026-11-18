/**
 * Supabase calls made the way the app does (plain HTTP to /auth/v1 and
 * /rest/v1 with the anon key + the user's access token), plus a few
 * service-role helpers used ONLY for setup, cleanup and inspection.
 */
import { env } from './env.js';
import { request, type HttpResult, type Json } from './http.js';

export interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

function anonHeaders(token?: string | null): Record<string, string> {
  const { anonKey } = env();
  return { apikey: anonKey, Authorization: `Bearer ${token ?? anonKey}` };
}

export function authSignUp(email: string, password: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: anonHeaders(),
    body: { email, password },
  });
}

export function authSignIn(email: string, password: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: anonHeaders(),
    body: { email, password },
  });
}

export function authRefresh(refreshToken: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: anonHeaders(),
    body: { refresh_token: refreshToken },
  });
}

export function authSignOut(accessToken: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/logout`, { method: 'POST', headers: anonHeaders(accessToken) });
}

export function authGetUser(accessToken: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/user`, { headers: anonHeaders(accessToken) });
}

/** PostgREST as a signed-in user (token) or anon-only (token null). */
export function rest(
  token: string | null,
  pathAndQuery: string,
  opts: { method?: string; body?: unknown; prefer?: string } = {}
): Promise<HttpResult> {
  return request(`${env().apiUrl}/rest/v1/${pathAndQuery}`, {
    method: opts.method ?? 'GET',
    headers: { ...anonHeaders(token), ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body,
  });
}

export function rpc(token: string | null, name: string, args: Record<string, unknown> = {}): Promise<HttpResult> {
  return rest(token, `rpc/${name}`, { method: 'POST', body: args });
}

// ---------------------------------------------------------------------------
// Service role: setup / cleanup / inspection only. Never used to do something
// the app is supposed to do.
// ---------------------------------------------------------------------------

function serviceHeaders(): Record<string, string> {
  const { serviceKey } = env();
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

export function svcRest(
  pathAndQuery: string,
  opts: { method?: string; body?: unknown; prefer?: string } = {}
): Promise<HttpResult> {
  return request(`${env().apiUrl}/rest/v1/${pathAndQuery}`, {
    method: opts.method ?? 'GET',
    headers: { ...serviceHeaders(), ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body,
  });
}

export function adminDeleteUser(userId: string): Promise<HttpResult> {
  return request(`${env().apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(),
  });
}

export function expectOk(res: HttpResult, label: string): Json {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body;
}
