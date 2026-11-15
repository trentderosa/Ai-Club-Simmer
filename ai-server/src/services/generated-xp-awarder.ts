/**
 * Server-side XP awarding for cook-anything via award_generated_recipe_xp.
 * Same transport pattern as SupabaseXpAwarder / award_slot_xp.
 */
import {
  DEFAULT_XP_AWARD_TIMEOUT_MS,
  XpAwardError,
  type XpAwarder,
  type XpAwardResult,
  type SupabaseXpAwarderConfig,
} from './xp-awarder.js';

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

export class SupabaseGeneratedXpAwarder implements XpAwarder {
  private restUrl: string;
  private rpcUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: SupabaseXpAwarderConfig) {
    this.restUrl = `${config.url}/rest/v1`;
    this.rpcUrl = `${this.restUrl}/rpc/award_generated_recipe_xp`;
    this.headers = {
      'Content-Type': 'application/json',
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
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
        throw new XpAwardError(
          'timeout',
          `award_generated_recipe_xp timed out after ${this.timeoutMs}ms`
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new XpAwardError('network', `award_generated_recipe_xp request failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async callRpc(checkInId: string, signal: AbortSignal): Promise<XpAwardResult> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ p_check_in_id: checkInId }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (isUniqueViolation(response.status, errorText)) {
        const existing = await this.fetchExistingAward(checkInId, signal);
        if (existing) return existing;
        throw new XpAwardError(
          'already_awarded',
          `award_generated_recipe_xp failed: ${response.status} ${errorText}`,
          response.status
        );
      }
      throw new XpAwardError(
        'http',
        `award_generated_recipe_xp failed: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = (await response.json()) as AwardRow | AwardRow[];
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.out_xp_awarded !== 'number') {
      throw new XpAwardError('invalid_response', 'award_generated_recipe_xp returned no result row');
    }
    return {
      xp_awarded: row.out_xp_awarded,
      is_first_completion: row.out_is_first_completion,
      weekly_repeat_remaining: row.out_weekly_repeat_remaining,
      capped: row.out_capped,
    };
  }

  private async fetchExistingAward(
    checkInId: string,
    signal: AbortSignal
  ): Promise<XpAwardResult | null> {
    const url = new URL(`${this.restUrl}/generated_recipe_xp_events`);
    url.searchParams.set('select', 'xp_awarded,is_first_completion');
    url.searchParams.set('check_in_id', `eq.${checkInId}`);
    url.searchParams.set('limit', '1');
    const response = await fetch(url.toString(), { method: 'GET', headers: this.headers, signal });
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
