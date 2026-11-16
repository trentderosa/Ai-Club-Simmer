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
  | 'unavailable' // 503 auth service down
  | 'server' // other 5xx
  | 'network' // fetch failed or timed out
  | 'bad_response' // response didn't match the contract
  | 'config'; // missing env vars

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
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
  if (status === 503) return 'unavailable';
  if (status === 500 && route === 'recipe') return 'generation_failed';
  return 'server';
}
