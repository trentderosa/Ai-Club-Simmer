import type {
  ReconcileCandidate,
  ReconcileCandidateSource,
  ReconcileWindow,
} from './reconcile-xp-core.js';

export interface SupabaseReconcileSourceConfig {
  url: string;
  serviceRoleKey: string;
  timeoutMs: number;
}

interface CandidateRow {
  id: string;
  slot_id: number;
  created_at: string;
}

/**
 * Reads check-ins with no xp_events row over PostgREST with the service-role
 * key. No new SQL: it is an anti-join on the existing xp_events.check_in_id
 * foreign key (embed xp_events, then filter xp_events=is.null), equivalent to
 *
 *   SELECT c.id, c.slot_id, c.created_at FROM check_ins c
 *   WHERE NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
 *     AND c.created_at >= :from AND c.created_at <= :to
 *   ORDER BY c.created_at, c.id LIMIT :limit;
 *
 * Only ids, slot ids and timestamps are read; no check-in text or user data.
 */
export class SupabaseReconcileSource implements ReconcileCandidateSource {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: SupabaseReconcileSourceConfig) {
    this.baseUrl = `${config.url}/rest/v1`;
    this.headers = {
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
    };
    this.timeoutMs = config.timeoutMs;
  }

  buildUrl(window: ReconcileWindow): string {
    const url = new URL(`${this.baseUrl}/check_ins`);
    url.searchParams.set('select', 'id,slot_id,created_at,xp_events(id)');
    url.searchParams.set('xp_events', 'is.null');
    url.searchParams.append('created_at', `gte.${window.from.toISOString()}`);
    url.searchParams.append('created_at', `lte.${window.to.toISOString()}`);
    url.searchParams.set('order', 'created_at.asc,id.asc');
    url.searchParams.set('limit', String(window.limit));
    return url.toString();
  }

  async findCheckInsMissingXp(window: ReconcileWindow): Promise<ReconcileCandidate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.buildUrl(window), {
        method: 'GET',
        headers: this.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Database error listing check-ins missing XP: ${response.status} ${errorText}`);
      }
      const data = (await response.json()) as CandidateRow[];
      if (!Array.isArray(data)) {
        throw new Error('Database error listing check-ins missing XP: unexpected response');
      }
      return data.map((row) => ({
        check_in_id: row.id,
        slot_id: row.slot_id,
        created_at: row.created_at,
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Listing check-ins missing XP timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
