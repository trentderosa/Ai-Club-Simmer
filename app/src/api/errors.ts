/**
 * One error type for every backend call, so screens can switch on `kind`
 * instead of parsing HTTP statuses.
 */
export type ApiErrorKind =
  | 'unauthorized' // 401: bad or expired token -> sign in again
  | 'slot_locked' // 403 SLOT_LOCKED
  | 'onboarding_required' // 404 "Please complete onboarding first"
  | 'not_found' // other 404s (unknown slot, missing user_recipes row)
  | 'generation_failed' // 500 from recipe generation: show Retry (F3)
  | 'rate_limited' // 429
  | 'invalid_recipe' // 400 INVALID_RECIPE
  | 'validation' // 400 VALIDATION_ERROR / other 400s
  | 'mastery_session_used' // 409 MASTERY_SESSION_USED: that cook is already checked in
  | 'unavailable' // 503: auth service down, or the AI server cannot take the request
  | 'busy' // 503 GENERATION_BUSY: the shared model queue is full, retry shortly
  | 'server' // other 5xx, including GENERATION_RATE_LIMIT_UNAVAILABLE
  | 'timeout' // the AI server did not answer before the client gave up
  | 'network' // fetch failed: the AI server was unreachable
  | 'bad_response' // response didn't match the contract
  | 'config'; // missing env vars

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    /** Seconds from a valid integer `Retry-After` header (1-300), else undefined. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/**
 * Maps an ai-server HTTP error to a kind. `route` matters for 404 and 500:
 * the recipe route's 500 means "generation failed, retry"; the 404 that
 * means "finish onboarding" has no code, only its message (see CLIENT_API).
 */
export type ApiRoute = 'recipe' | 'check-in' | 'mastery';

export function kindForHttpError(
  status: number,
  code: string | undefined,
  message: string,
  route: ApiRoute,
): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403 && code === 'SLOT_LOCKED') return 'slot_locked';
  if (status === 404) return /onboarding/i.test(message) ? 'onboarding_required' : 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 && code === 'INVALID_RECIPE') return 'invalid_recipe';
  if (status === 409 && code === 'MASTERY_SESSION_USED') return 'mastery_session_used';
  if (status === 400 || (status === 409 && code === 'IDEMPOTENCY_CONFLICT')) return 'validation';
  if (status === 503 && code === 'GENERATION_RATE_LIMIT_UNAVAILABLE') return 'server';
  if (status === 503 && code === 'GENERATION_BUSY') return 'busy';
  if (status === 503) return 'unavailable';
  if (status === 500 && route === 'recipe') return 'generation_failed';
  return 'server';
}

export const RETRY_AFTER_MIN_SECONDS = 1;
export const RETRY_AFTER_MAX_SECONDS = 300;

/**
 * Reads a `Retry-After` header value as whole seconds, clamped to 1-300.
 * HTTP-dates and anything that is not a plain non-negative integer give
 * undefined, so the message falls back to "in a minute".
 */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds));
}
