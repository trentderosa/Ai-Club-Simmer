/**
 * Server-side XP awarding via the award_slot_xp RPC.
 *
 * award_slot_xp(p_check_in_id UUID) is EXECUTE-granted to service_role only
 * (migration 20261112220000_lock_rpc_execute_grants.sql). The client never
 * calls it; only the ai-server does, with the service-role key, right after a
 * check-in row is saved. The function itself applies the XP formula, the 50%
 * repeat rule, the weekly repeat cap, the per-user advisory lock and
 * UNIQUE(check_in_id), so this module is a thin, injectable transport.
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

export interface SupabaseXpAwarderConfig {
  url: string;
  serviceRoleKey: string;
}

interface AwardRow {
  out_xp_awarded: number;
  out_is_first_completion: boolean;
  out_weekly_repeat_remaining: number;
  out_capped: boolean;
}

/**
 * Calls POST {SUPABASE_URL}/rest/v1/rpc/award_slot_xp with the service-role key.
 * Errors never include request headers, so the key cannot leak into logs.
 */
export class SupabaseXpAwarder implements XpAwarder {
  private rpcUrl: string;
  private headers: Record<string, string>;

  constructor(config: SupabaseXpAwarderConfig) {
    this.rpcUrl = `${config.url}/rest/v1/rpc/award_slot_xp`;
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceRoleKey,
      'Authorization': `Bearer ${config.serviceRoleKey}`,
    };
  }

  async award(checkInId: string): Promise<XpAwardResult> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ p_check_in_id: checkInId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`award_slot_xp failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as AwardRow | AwardRow[];
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.out_xp_awarded !== 'number') {
      throw new Error('award_slot_xp returned no result row');
    }

    return {
      xp_awarded: row.out_xp_awarded,
      is_first_completion: row.out_is_first_completion,
      weekly_repeat_remaining: row.out_weekly_repeat_remaining,
      capped: row.out_capped,
    };
  }
}
