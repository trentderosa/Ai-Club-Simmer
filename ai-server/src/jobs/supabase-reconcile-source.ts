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

interface SlotCandidateRow {
  id: string;
  slot_id: number;
  created_at: string;
}

interface GeneratedCandidateRow {
  id: string;
  created_at: string;
}

/**
 * Reads check-ins with no XP row over PostgREST with the service-role key.
 * No new SQL: two anti-joins on the existing foreign keys (embed the XP
 * table, then filter it is.null), equivalent to
 *
 *   SELECT id, slot_id, created_at, 'slot' FROM check_ins c
 *   WHERE NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.check_in_id = c.id)
 *     AND created_at is in the window
 *   UNION ALL
 *   SELECT id, NULL, created_at, 'generated' FROM generated_recipe_check_ins g
 *   WHERE NOT EXISTS (
 *     SELECT 1 FROM generated_recipe_xp_events e WHERE e.check_in_id = g.id)
 *     AND created_at is in the window
 *   ORDER BY created_at, id LIMIT :limit;
 *
 * Each read asks for its own oldest `limit` rows. The global oldest `limit`
 * is always inside that union, so the merge below matches one combined query.
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
    return this.buildTableUrl('check_ins', 'id,slot_id,created_at,xp_events(id)', 'xp_events', window);
  }

  buildGeneratedUrl(window: ReconcileWindow): string {
    return this.buildTableUrl(
      'generated_recipe_check_ins',
      'id,created_at,generated_recipe_xp_events(id)',
      'generated_recipe_xp_events',
      window
    );
  }

  private buildTableUrl(
    table: string,
    select: string,
    xpEmbed: string,
    window: ReconcileWindow
  ): string {
    const url = new URL(`${this.baseUrl}/${table}`);
    url.searchParams.set('select', select);
    url.searchParams.set(xpEmbed, 'is.null');
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
      const [slots, generated] = await Promise.all([
        this.fetchRows<SlotCandidateRow>(this.buildUrl(window), controller.signal),
        this.fetchRows<GeneratedCandidateRow>(this.buildGeneratedUrl(window), controller.signal),
      ]);
      return mergeReconcileCandidates(
        [
          ...slots.map((row) => ({
            check_in_id: row.id,
            slot_id: row.slot_id,
            created_at: row.created_at,
            kind: 'slot' as const,
          })),
          ...generated.map((row) => ({
            check_in_id: row.id,
            slot_id: null,
            created_at: row.created_at,
            kind: 'generated' as const,
          })),
        ],
        window.limit
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Listing check-ins missing XP timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchRows<T>(url: string, signal: AbortSignal): Promise<T[]> {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database error listing check-ins missing XP: ${response.status} ${errorText}`);
    }
    const data = (await response.json()) as T[];
    if (!Array.isArray(data)) {
      throw new Error('Database error listing check-ins missing XP: unexpected response');
    }
    return data;
  }
}

/** Oldest first, then id, capped at the shared batch limit. */
export function mergeReconcileCandidates(
  rows: ReconcileCandidate[],
  limit: number
): ReconcileCandidate[] {
  return [...rows]
    .sort((a, b) => {
      const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
      if (byTime !== 0) return byTime;
      if (a.check_in_id === b.check_in_id) return 0;
      return a.check_in_id < b.check_in_id ? -1 : 1;
    })
    .slice(0, limit)
    .map((row) => ({ ...row, kind: reconcileCandidateKind(row) }));
}
