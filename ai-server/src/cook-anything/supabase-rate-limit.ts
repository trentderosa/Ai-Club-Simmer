import { SupabaseRest, SupabaseRestError, type SupabaseRestConfig } from '../services/supabase-rest.js';
import type { CookAnythingGenerationLimiter } from './rate-limit.js';

export interface SupabaseGenerationRateLimiterConfig extends SupabaseRestConfig {
  windowMs: number;
  maxGenerations: number;
}

/**
 * Sliding window stored in cook_anything_generation_hits via
 * try_cook_anything_generation. A new process sees rows the previous one wrote.
 */
export class SupabaseGenerationRateLimiter implements CookAnythingGenerationLimiter {
  private readonly rest: SupabaseRest;
  private readonly windowMs: number;
  private readonly maxGenerations: number;

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
}
