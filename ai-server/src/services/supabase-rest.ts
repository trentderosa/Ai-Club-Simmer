/**
 * Minimal PostgREST client for the ai-server's service-role reads and RPCs.
 *
 * - Every request aborts after `timeoutMs` (request and body read).
 * - Error messages include the status and, when safe, the PostgREST error
 *   code. Never the headers (so the service-role key cannot leak) and never
 *   the response body (it can echo row values such as user emails). The body
 *   stays on the error's non-enumerable `body` field for code that parses it.
 */
export interface SupabaseRestConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs?: number;
}

export const DEFAULT_SUPABASE_REST_TIMEOUT_MS = 5000;

/**
 * Fixed failure category, safe to log.
 * Defaults to 'http' when a status is given, else 'invalid_response'.
 */
export type SupabaseRestErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response';

/** PostgREST (PGRST202) and Postgres SQLSTATE (23505, P0001) codes. */
const PG_CODE = /^[A-Z0-9]{5,8}$/;

/** The `code` field of a PostgREST error body, when it is a plain code. */
export function postgrestCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = typeof parsed === 'object' && parsed !== null ? (parsed as { code?: unknown }).code : undefined;
    return typeof code === 'string' && PG_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** `<prefix>: <status>` plus ` (<code>)` when the body has a safe code. Never the body. */
export function httpFailureMessage(prefix: string, status: number, body: string): string {
  const code = postgrestCode(body);
  return `${prefix}: ${status}${code ? ` (${code})` : ''}`;
}

export class SupabaseRestError extends Error {
  readonly kind: SupabaseRestErrorKind;
  /** PostgREST/Postgres error code from the body, when safe (see postgrestCode). */
  readonly pgCode?: string;
  /** Raw response body, for code that parses it. Non-enumerable so it is not logged. */
  declare readonly body?: string;

  constructor(
    message: string,
    readonly status?: number,
    options: { kind?: SupabaseRestErrorKind; cause?: unknown; body?: string } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SupabaseRestError';
    this.kind = options.kind ?? (status === undefined ? 'invalid_response' : 'http');
    if (options.body !== undefined) {
      Object.defineProperty(this, 'body', { value: options.body, enumerable: false });
      const code = postgrestCode(options.body);
      if (code) this.pgCode = code;
    }
  }

  /** Error for a non-2xx response: message has status and safe code, body kept aside. */
  static fromResponse(prefix: string, status: number, body: string): SupabaseRestError {
    return new SupabaseRestError(httpFailureMessage(prefix, status, body), status, { body });
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
        throw SupabaseRestError.fromResponse(`Supabase ${label} failed`, response.status, text);
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
