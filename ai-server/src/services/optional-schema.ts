/**
 * Rollout safety for personalization. Migrations reach production after the
 * ai-server code is merged, so reads of the new profiles.dietary_needs column
 * and the user_path_dishes / dish_catalog tables must tolerate a database
 * that does not have them yet. A missing-schema failure is remembered briefly
 * so the fallback does not double every request.
 */
import { SupabaseRestError } from './supabase-rest.js';

/** How long a "not in this database yet" answer is remembered. */
export const UNAVAILABLE_CACHE_MS = 60_000;

/** PostgREST 400 with Postgres undefined_column (42703). */
export function isMissingColumnError(error: unknown): boolean {
  return error instanceof SupabaseRestError && error.kind === 'http' && error.status === 400 && error.pgCode === '42703';
}

/** PostgREST PGRST205 (table not in schema cache) or Postgres undefined_table (42P01). A bare 404 is not enough. */
export function isMissingTableError(error: unknown): boolean {
  if (!(error instanceof SupabaseRestError) || error.kind !== 'http') return false;
  return error.pgCode === 'PGRST205' || error.pgCode === '42P01';
}

/** Remembers for a short time that an optional column or table is missing. */
export class UnavailableMemo {
  private until = 0;

  constructor(
    private readonly ttlMs: number = UNAVAILABLE_CACHE_MS,
    private readonly now: () => number = (): number => Date.now()
  ) {}

  isUnavailable(): boolean {
    return this.now() < this.until;
  }

  markUnavailable(): void {
    this.until = this.now() + this.ttlMs;
  }
}

/**
 * Run `read`, treating a missing-schema error (per `isMissing`) as `fallback`
 * and remembering it. Any other error still throws.
 */
export async function readOptional<T>(
  memo: UnavailableMemo,
  isMissing: (error: unknown) => boolean,
  fallback: T,
  read: () => Promise<T>,
  logger?: { warn(message: string, context: Record<string, unknown>): void },
  what = 'optional_schema'
): Promise<T> {
  if (memo.isUnavailable()) return fallback;
  try {
    return await read();
  } catch (error) {
    if (!isMissing(error)) throw error;
    memo.markUnavailable();
    // Safe fields only: never the response body.
    logger?.warn('optional_schema_unavailable', {
      what,
      status: error instanceof SupabaseRestError ? error.status : undefined,
      code: error instanceof SupabaseRestError ? error.pgCode : undefined,
    });
    return fallback;
  }
}
