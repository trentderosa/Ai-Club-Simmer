import type { Express, Request, Response as ExpressResponse } from 'express';

/** Per-check limit. Checks run together, so the route waits at most this long. */
export const DEEP_HEALTH_TIMEOUT_MS = 2000;

/** How long GET /health/deep reuses the last report (ok, degraded, or fail). */
export const DEEP_HEALTH_CACHE_TTL_MS = 5000;

/** Ollama and Supabase. These two gate whether the endpoint succeeds. */
export type HealthStatus = 'ok' | 'fail';

/**
 * Overall deep-health result.
 * `degraded` means Ollama and Supabase are up and YouTube was skipped.
 * The route returns HTTP 200 for `ok` and `degraded`, and 503 for `fail`.
 */
export type DeepHealthStatus = 'ok' | 'degraded' | 'fail';

/** YouTube is a key-presence check. A missing key is skipped, not a failure. */
export type YouTubeHealthStatus = 'ok' | 'skipped';

/** Fixed codes only. Never a URL, key, or error message. */
export type HealthFailReason = 'not_configured' | 'unreachable' | 'timeout' | 'model_missing';

export interface HealthCheck {
  status: HealthStatus;
  reason?: HealthFailReason;
}

export interface YouTubeHealthCheck {
  status: YouTubeHealthStatus;
  /** Present when the key is missing. The key itself is never copied here. */
  reason?: 'not_configured';
}

export interface DeepHealthReport {
  status: DeepHealthStatus;
  checks: {
    ollama: HealthCheck;
    supabase: HealthCheck;
    youtube: YouTubeHealthCheck;
  };
}

export interface DeepHealthDeps {
  ollamaBaseUrl: string;
  ollamaModel: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  /** Present or not. The value is never copied into the report. */
  youtubeApiKey?: string;
  timeoutMs?: number;
  /** Override for tests. Default is DEEP_HEALTH_CACHE_TTL_MS. */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Failures warn on every fresh check. A missing YouTube key is a normal
 * lasting `degraded` state, so that warning is logged only when the status
 * changes to `degraded`. Reason codes only: no keys, URLs, or error text.
 */
function logDeepHealth(report: DeepHealthReport, previousStatus: DeepHealthStatus | undefined): void {
  const details = {
    ollama: report.checks.ollama.reason ?? report.checks.ollama.status,
    supabase: report.checks.supabase.reason ?? report.checks.supabase.status,
    youtube: report.checks.youtube.reason ?? report.checks.youtube.status,
  };
  if (report.status === 'fail') {
    console.warn('health_deep_failed', details);
    return;
  }
  if (report.status === 'degraded' && previousStatus !== 'degraded') {
    console.warn('health_deep_degraded', details);
  }
}

/**
 * GET /health stays a process check. GET /health/deep reports dependencies.
 * YouTube is "is the key set?", not a Data API call, so it spends no quota
 * and does not change search caching or quota cooldown.
 * Ollama and Supabase gate success. A missing YouTube key is skipped and
 * the overall status is degraded (HTTP 200), not a failed check.
 */
export function mountHealthRoutes(app: Express, deps: DeepHealthDeps): void {
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  let cached: { report: DeepHealthReport; expiresAt: number } | null = null;
  let inflight: Promise<DeepHealthReport> | null = null;
  const cacheTtlMs = deps.cacheTtlMs ?? DEEP_HEALTH_CACHE_TTL_MS;

  function getDeepHealthReport(): Promise<DeepHealthReport> {
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      return Promise.resolve(cached.report);
    }
    if (inflight) {
      return inflight;
    }
    inflight = runDeepHealthCheck(deps)
      .then((report) => {
        const previousStatus = cached?.report.status;
        cached = { report, expiresAt: Date.now() + cacheTtlMs };
        logDeepHealth(report, previousStatus);
        return report;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.get('/health/deep', async (_req: Request, res: ExpressResponse) => {
    const report = await getDeepHealthReport();
    res.status(report.status === 'fail' ? 503 : 200).json(report);
  });
}

export async function runDeepHealthCheck(deps: DeepHealthDeps): Promise<DeepHealthReport> {
  const timeoutMs = deps.timeoutMs ?? DEEP_HEALTH_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const [ollama, supabase, youtube] = await Promise.all([
    checkOllama(deps.ollamaBaseUrl, deps.ollamaModel, timeoutMs, fetchImpl),
    checkSupabase(deps.supabaseUrl, deps.supabaseServiceRoleKey, timeoutMs, fetchImpl),
    Promise.resolve(checkYouTube(deps.youtubeApiKey)),
  ]);
  const status: DeepHealthStatus =
    ollama.status === 'fail' || supabase.status === 'fail'
      ? 'fail'
      : youtube.status === 'skipped'
        ? 'degraded'
        : 'ok';
  return { status, checks: { ollama, supabase, youtube } };
}

function checkYouTube(apiKey: string | undefined): YouTubeHealthCheck {
  if (!apiKey || apiKey.trim().length === 0) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  return { status: 'ok' };
}

async function checkOllama(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<HealthCheck> {
  const trimmedModel = model.trim();
  if (!baseUrl.trim() || !trimmedModel) {
    return { status: 'fail', reason: 'not_configured' };
  }
  let tagsUrl: string;
  try {
    tagsUrl = new URL('api/tags', withTrailingSlash(baseUrl)).toString();
  } catch {
    return { status: 'fail', reason: 'not_configured' };
  }

  const outcome = await getWithTimeout(fetchImpl, tagsUrl, { method: 'GET', redirect: 'manual' }, timeoutMs);
  if (outcome.status === 'fail') {
    return outcome;
  }
  let names: string[];
  try {
    names = modelNames(await outcome.response.json());
  } catch {
    return { status: 'fail', reason: 'unreachable' };
  }
  const listed = names.some((name) => name === trimmedModel || name.startsWith(`${trimmedModel}:`));
  return listed ? { status: 'ok' } : { status: 'fail', reason: 'model_missing' };
}

async function checkSupabase(
  url: string | undefined,
  serviceRoleKey: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<HealthCheck> {
  const key = serviceRoleKey?.trim();
  if (!url?.trim() || !key) {
    return { status: 'fail', reason: 'not_configured' };
  }
  let queryUrl: string;
  try {
    const endpoint = new URL('rest/v1/path_slots', withTrailingSlash(url));
    endpoint.searchParams.set('select', 'id');
    endpoint.searchParams.set('limit', '1');
    queryUrl = endpoint.toString();
  } catch {
    return { status: 'fail', reason: 'not_configured' };
  }

  const outcome = await getWithTimeout(
    fetchImpl,
    queryUrl,
    {
      method: 'GET',
      redirect: 'manual',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    },
    timeoutMs
  );
  if (outcome.status === 'fail') {
    return outcome;
  }
  // Drain so a hanging body cannot hold the check open past the timeout.
  try {
    await outcome.response.arrayBuffer();
  } catch {
    return { status: 'fail', reason: 'unreachable' };
  }
  return { status: 'ok' };
}

type FetchOutcome = { status: 'ok'; response: Response } | { status: 'fail'; reason: HealthFailReason };

async function getWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      await discard(response);
      return { status: 'fail', reason: 'unreachable' };
    }
    return { status: 'ok', response };
  } catch (error) {
    if (isTimeout(error)) {
      return { status: 'fail', reason: 'timeout' };
    }
    return { status: 'fail', reason: 'unreachable' };
  }
}

function modelNames(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('models' in body)) {
    return [];
  }
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.flatMap((model) => {
    if (!model || typeof model !== 'object' || !('name' in model)) {
      return [];
    }
    const name = (model as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isTimeout(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    ((error as { name?: string }).name === 'TimeoutError' || (error as { name?: string }).name === 'AbortError')
  );
}

async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The status already failed the check. Ignore a body we will not report.
  }
}
