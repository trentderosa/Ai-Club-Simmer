/**
 * Server-side XP awarding via the award_slot_xp RPC.
 *
 * award_slot_xp(p_check_in_id UUID) is EXECUTE-granted to service_role only
 * (migration 20261112220000_lock_rpc_execute_grants.sql). The client never
 * calls it; only the ai-server does, with the service-role key, right after a
 * check-in row is saved (and from the reconcile job, src/jobs/reconcile-xp.ts).
 * The function itself applies the XP formula, the 50% repeat rule, the weekly
 * repeat cap, the per-user advisory lock and UNIQUE(check_in_id), so this
 * module is a thin, injectable transport.
 */

export interface XpAwardResult {
  xp_awarded: number;
  is_first_completion: boolean;
  weekly_repeat_remaining: number;
  capped: boolean;
}

export interface XpAwarder {
  award(checkInId: string): Promise<XpAwardResult>;
}

/** Default budget for one award_slot_xp call (XP_AWARD_TIMEOUT_MS). */
export const DEFAULT_XP_AWARD_TIMEOUT_MS = 5000;

/**
 * Why an award failed. Logged as `reason`; never contains secrets.
 * - timeout: the call exceeded the timeout and was aborted. The database may
 *   still have committed the award; the reconcile job sorts that out safely.
 * - already_awarded: an xp_events row already exists for this check-in
 *   (UNIQUE(check_in_id) -> Postgres 23505 -> PostgREST 409) and the existing
 *   row could not be read back. award() itself returns that row on 409 when
 *   it can, so a retried check-in still reports the original XP. Reconcile
 *   treats a thrown already_awarded as done, not failed.
 * - http: any other non-OK response.
 * - network: fetch rejected for a reason other than the timeout.
 * - invalid_response: OK response without a result row.
 */
export type XpAwardErrorReason = 'timeout' | 'already_awarded' | 'http' | 'network' | 'invalid_response';

export class XpAwardError extends Error {
  constructor(
    readonly reason: XpAwardErrorReason,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'XpAwardError';
  }
}

export function xpAwardErrorReason(error: unknown): XpAwardErrorReason | 'unknown' {
  return error instanceof XpAwardError ? error.reason : 'unknown';
}

export interface SupabaseXpAwarderConfig {
  url: string;
  serviceRoleKey: string;
  /** Abort the RPC after this many ms. Defaults to DEFAULT_XP_AWARD_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface AwardRow {
  out_xp_awarded: number;
  out_is_first_completion: boolean;
  out_weekly_repeat_remaining: number;
  out_capped: boolean;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(status: number, body: string): boolean {
  if (status !== 409) return false;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return parsed.code === UNIQUE_VIOLATION;
  } catch {
    return false;
  }
}

/**
 * Calls POST {SUPABASE_URL}/rest/v1/rpc/award_slot_xp with the service-role key,
 * aborting after `timeoutMs`. Errors never include request headers, so the key
 * cannot leak into logs.
 */
export class SupabaseXpAwarder implements XpAwarder {
  private restUrl: string;
  private rpcUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: SupabaseXpAwarderConfig) {
    this.restUrl = `${config.url}/rest/v1`;
    this.rpcUrl = `${this.restUrl}/rpc/award_slot_xp`;
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_XP_AWARD_TIMEOUT_MS;
  }

  async award(checkInId: string): Promise<XpAwardResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.callRpc(checkInId, controller.signal);
    } catch (error) {
      if (error instanceof XpAwardError) throw error;
      if (controller.signal.aborted) {
        throw new XpAwardError('timeout', `award_slot_xp timed out after ${this.timeoutMs}ms`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new XpAwardError('network', `award_slot_xp request failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async callRpc(checkInId: string, signal: AbortSignal): Promise<XpAwardResult> {
    // The signal covers both the request and reading the body.
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ p_check_in_id: checkInId }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (isUniqueViolation(response.status, errorText)) {
        // A retry of the same check-in: UNIQUE(check_in_id) fired, so XP was
        // already granted once. Return that row instead of throwing, so the
        // check-in response can show the real amount instead of "failed".
        const existing = await this.fetchExistingAward(checkInId, signal);
        if (existing) return existing;
        throw new XpAwardError(
          'already_awarded',
          `award_slot_xp failed: ${response.status} ${errorText}`,
          response.status
        );
      }
      throw new XpAwardError(
        'http',
        `award_slot_xp failed: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = (await response.json()) as AwardRow | AwardRow[];
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.out_xp_awarded !== 'number') {
      throw new XpAwardError('invalid_response', 'award_slot_xp returned no result row');
    }

    return {
      xp_awarded: row.out_xp_awarded,
      is_first_completion: row.out_is_first_completion,
      weekly_repeat_remaining: row.out_weekly_repeat_remaining,
      capped: row.out_capped,
    };
  }

  /**
   * Read the xp_events row written by the first award. `capped` and
   * `weekly_repeat_remaining` are not stored on that row; `capped` is true
   * only when a repeat earned 0 XP (the weekly cap was already full).
   */
  private async fetchExistingAward(
    checkInId: string,
    signal: AbortSignal
  ): Promise<XpAwardResult | null> {
    const url = new URL(`${this.restUrl}/xp_events`);
    url.searchParams.set('select', 'xp_awarded,is_first_completion');
    url.searchParams.set('check_in_id', `eq.${checkInId}`);
    url.searchParams.set('limit', '1');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
      signal,
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Array<{
      xp_awarded?: unknown;
      is_first_completion?: unknown;
    }>;
    const row = Array.isArray(data) ? data[0] : undefined;
    if (!row || typeof row.xp_awarded !== 'number' || typeof row.is_first_completion !== 'boolean') {
      return null;
    }
    return {
      xp_awarded: row.xp_awarded,
      is_first_completion: row.is_first_completion,
      weekly_repeat_remaining: 0,
      capped: !row.is_first_completion && row.xp_awarded === 0,
    };
  }
}
