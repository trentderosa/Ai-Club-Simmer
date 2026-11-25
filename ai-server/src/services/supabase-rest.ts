/**
 * Minimal PostgREST client for the ai-server's service-role reads and RPCs.
 *
 * - Every request aborts after `timeoutMs` (request and body read).
 * - Error messages include the status and PostgREST body, never the headers,
 *   so the service-role key cannot leak into logs.
 */
export interface SupabaseRestConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs?: number;
}

export const DEFAULT_SUPABASE_REST_TIMEOUT_MS = 5000;

/**
 * Fixed failure category, safe to log (the message may hold a response body).
 * Defaults to 'http' when a status is given, else 'invalid_response'.
 */
export type SupabaseRestErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response';

export class SupabaseRestError extends Error {
  readonly kind: SupabaseRestErrorKind;

  constructor(
    message: string,
    readonly status?: number,
    options: { kind?: SupabaseRestErrorKind; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SupabaseRestError';
    this.kind = options.kind ?? (status === undefined ? 'invalid_response' : 'http');
  }
}

export class SupabaseRest {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: SupabaseRestConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SUPABASE_REST_TIMEOUT_MS;
  }

  /** GET /rest/v1/{table}?{params}. Returns the parsed JSON array. */
  async select<T>(table: string, params: Record<string, string>): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/${table}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const data = await this.request<unknown>(url.toString(), { method: 'GET' }, `select ${table}`);
    return Array.isArray(data) ? (data as T[]) : [];
  }

  /** POST /rest/v1/rpc/{fn} with a JSON body. */
  async rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      `${this.baseUrl}/rpc/${fn}`,
      { method: 'POST', body: JSON.stringify(body) },
      `rpc ${fn}`
    );
  }

  /** POST /rest/v1/{table} upserting on the primary key. */
  async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    await this.request<unknown>(
      `${this.baseUrl}/${table}`,
      {
        method: 'POST',
        body: JSON.stringify(rows),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      },
      `upsert ${table}`
    );
  }

  private async request<T>(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    label: string
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: { ...this.headers, ...init.headers },
        body: init.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new SupabaseRestError(`Supabase ${label} failed: ${response.status} ${text}`, response.status);
      }
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    } catch (error) {
      if (error instanceof SupabaseRestError) throw error;
      if (controller.signal.aborted) {
        throw new SupabaseRestError(`Supabase ${label} timed out after ${this.timeoutMs}ms`, undefined, {
          kind: 'timeout',
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      // JSON.parse of a 200 body is inside the try; that is a bad response, not a network failure.
      const kind = error instanceof SyntaxError ? 'invalid_response' : 'network';
      throw new SupabaseRestError(`Supabase ${label} request failed: ${detail}`, undefined, { kind, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
