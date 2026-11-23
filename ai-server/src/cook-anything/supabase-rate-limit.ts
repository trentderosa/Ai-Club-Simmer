import { SupabaseRest, SupabaseRestError, type SupabaseRestConfig } from '../services/supabase-rest.js';
import type { CookAnythingGenerationLimiter } from './rate-limit.js';

export interface SupabaseGenerationRateLimiterConfig extends SupabaseRestConfig {
  windowMs: number;
  maxGenerations: number;
}

/**
 * Sliding window stored in cook_anything_generation_hits via
 * try_cook_anything_generation. A new process sees rows the previous one wrote.
 * refund() calls refund_cook_anything_generation (migration
 * 20261121200000_cook_anything_generation_refund.sql, applied after merge).
 */
export class SupabaseGenerationRateLimiter implements CookAnythingGenerationLimiter {
  private readonly rest: SupabaseRest;
  private readonly windowMs: number;
  private readonly maxGenerations: number;
  private warnedRefundMissing = false;

  constructor(config: SupabaseGenerationRateLimiterConfig) {
    this.rest = new SupabaseRest({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      timeoutMs: config.timeoutMs,
    });
    this.windowMs = config.windowMs;
    this.maxGenerations = config.maxGenerations;
  }

  async allow(userId: string, now?: number): Promise<boolean> {
    const body: Record<string, unknown> = {
      p_user_id: userId,
      p_window_ms: this.windowMs,
      p_max: this.maxGenerations,
    };
    if (now !== undefined) {
      body.p_now = new Date(now).toISOString();
    }
    const result = await this.rest.rpc<unknown>('try_cook_anything_generation', body);
    if (typeof result !== 'boolean') {
      throw new SupabaseRestError('try_cook_anything_generation returned a non-boolean');
    }
    return result;
  }

  async refund(userId: string, now?: number): Promise<boolean> {
    const body: Record<string, unknown> = {
      p_user_id: userId,
      p_window_ms: this.windowMs,
    };
    if (now !== undefined) {
      body.p_now = new Date(now).toISOString();
    }
    let result: unknown;
    try {
      result = await this.rest.rpc<unknown>('refund_cook_anything_generation', body);
    } catch (error) {
      // Migration not applied yet: PostgREST answers 404 (PGRST202). Keep the
      // old behavior (the hit stays charged) and say so once, not per request.
      if (error instanceof SupabaseRestError && isMissingFunction(error)) {
        if (!this.warnedRefundMissing) {
          this.warnedRefundMissing = true;
          console.warn('cook_anything_refund_unavailable', {
            reason: 'refund_cook_anything_generation is missing; apply migration 20261121200000',
          });
        }
        return false;
      }
      throw error;
    }
    if (typeof result !== 'boolean') {
      throw new SupabaseRestError('refund_cook_anything_generation returned a non-boolean');
    }
    return result;
  }
}

function isMissingFunction(error: SupabaseRestError): boolean {
  return error.status === 404 || error.message.includes('PGRST202');
}
