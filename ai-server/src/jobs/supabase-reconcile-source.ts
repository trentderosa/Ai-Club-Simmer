import {
  reconcileCandidateKind,
  type ReconcileCandidate,
  type ReconcileCandidateSource,
  type ReconcileWindow,
} from './reconcile-xp-core.js';

export interface SupabaseReconcileSourceConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

interface CandidateRow {
  check_in_id: string;
  slot_id: number | null;
  created_at: string;
  kind: string;
}

/**
 * Reads check-ins with no XP row, and records failed attempts, over PostgREST
 * RPC with the service-role key. The SQL lives in migration
 * 20261118120000_xp_award_attempts.sql (all three functions are EXECUTE-granted
 * to service_role only):
 *
 *   get_xp_reconcile_candidates(p_from, p_to, p_limit, p_max_attempts, p_retry_base_minutes)
 *     check_ins with no xp_events row UNION ALL generated_recipe_check_ins with
 *     no generated_recipe_xp_events row, inside the window, left-joined to
 *     xp_award_attempts. Never attempted first, then oldest last_attempt_at,
 *     then created_at, id. Rows with attempts >= p_max_attempts are excluded,
 *     and a row with n attempts waits base * 2^(n-1) minutes (max 24 h).
 *   list_xp_reconcile_given_up(p_from, p_to, p_max_attempts, p_limit): ids only
 *   count_xp_reconcile_given_up(p_from, p_to, p_max_attempts)
 *   record_xp_award_attempt(p_check_in_id, p_kind, p_reason)
 *
 * Only ids, slot ids, timestamps and short reason codes cross this boundary;
 * no check-in text or user data.
 */
export class SupabaseReconcileSource implements ReconcileCandidateSource {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: SupabaseReconcileSourceConfig) {
    this.baseUrl = `${config.url}/rest/v1/rpc`;
    this.headers = {
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    };
    this.timeoutMs = config.timeoutMs;
  }

  private windowBody(window: ReconcileWindow): Record<string, unknown> {
    return {
      p_from: window.from.toISOString(),
      p_to: window.to.toISOString(),
      p_max_attempts: window.maxAttempts,
    };
  }

  async listGivenUp(window: ReconcileWindow, limit: number): Promise<string[]> {
    const rows = await this.rpc<Array<{ check_in_id: string }>>(
      'list_xp_reconcile_given_up',
      { ...this.windowBody(window), p_limit: limit },
      'listing given-up check-ins'
    );
    return Array.isArray(rows) ? rows.map((row) => row.check_in_id) : [];
  }

  async findCheckInsMissingXp(window: ReconcileWindow): Promise<ReconcileCandidate[]> {
    const rows = await this.rpc<CandidateRow[]>(
      'get_xp_reconcile_candidates',
      { ...this.windowBody(window), p_limit: window.limit, p_retry_base_minutes: window.retryBaseMinutes },
      'listing check-ins missing XP'
    );
    if (!Array.isArray(rows)) {
      throw new Error('Database error listing check-ins missing XP: unexpected response');
    }
    return rows.map((row) => ({
      check_in_id: row.check_in_id,
      slot_id: row.slot_id,
      created_at: row.created_at,
      kind: row.kind === 'generated' ? ('generated' as const) : ('slot' as const),
    }));
  }

  async countGivenUp(window: ReconcileWindow): Promise<number> {
    const count = await this.rpc<number>(
      'count_xp_reconcile_given_up',
      this.windowBody(window),
      'counting given-up check-ins'
    );
    return typeof count === 'number' ? count : 0;
  }

  async recordFailedAttempt(candidate: ReconcileCandidate, reason: string): Promise<void> {
    await this.rpc<unknown>(
      'record_xp_award_attempt',
      {
        p_check_in_id: candidate.check_in_id,
        p_kind: reconcileCandidateKind(candidate) === 'generated' ? 'generated' : 'path',
        p_reason: reason,
      },
      'recording an XP award attempt'
    );
  }

  private async rpc<T>(name: string, body: Record<string, unknown>, what: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${name}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404 || errorText.includes('PGRST202')) {
          throw new Error('xp_award_attempts migration not applied (20261118120000)');
        }
        throw new Error(`Database error ${what}: ${response.status} ${errorText}`);
      }
      // Void functions answer with an empty body (204).
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${what.charAt(0).toUpperCase()}${what.slice(1)} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
