/**
 * User-facing copy for every ApiError kind (per docs/CLIENT_API.md error
 * lists). Screens pick the action button from `action`.
 */
import { isApiError, type ApiErrorKind } from '../api/errors';
import { PASSWORD_RESET_EMAIL_LIMIT_COPY } from './password-reset';

export type ErrorAction = 'retry' | 'sign_in' | 'onboarding' | 'back';

export interface ErrorCopy {
  title: string;
  body: string;
  action: ErrorAction;
}

const COPY: Record<ApiErrorKind, ErrorCopy> = {
  unauthorized: { title: 'You’ve been signed out', body: 'Your session expired. Sign in again to keep going.', action: 'sign_in' },
  slot_locked: { title: 'Not unlocked yet', body: 'Finish the earlier dishes on your path first. Each one unlocks the next.', action: 'back' },
  onboarding_required: { title: 'Finish setting up first', body: 'Your coach needs your kitchen and schedule before it can write recipes for you.', action: 'onboarding' },
  not_found: { title: 'Couldn’t find that', body: 'This item doesn’t exist, or it hasn’t been created yet.', action: 'back' },
  generation_failed: { title: 'The recipe didn’t come out right', body: 'Your coach tried three times and couldn’t write a usable recipe. Give it another go.', action: 'retry' },
  rate_limited: { title: 'Slow down a little', body: 'Too many requests in a short time. Wait a minute, then try again.', action: 'retry' },
  invalid_recipe: { title: 'That recipe doesn’t match', body: 'This check-in doesn’t line up with your saved recipe. Open the recipe again, then check in.', action: 'back' },
  mastery_session_used: { title: 'Already checked in', body: 'This cook was already saved. Open cook mode again to start a fresh mastery run.', action: 'back' },
  validation: { title: 'Something’s off with that', body: 'Some of the details weren’t accepted. Check them and try again.', action: 'retry' },
  unavailable: { title: 'Sign-in service is down', body: 'The server couldn’t check your login just now. Try again in a moment.', action: 'retry' },
  server: { title: 'Something went wrong', body: 'The server hit an error. Try again in a moment.', action: 'retry' },
  timeout: { title: 'This is taking too long', body: 'The AI server didn’t answer in time. Try again in a moment.', action: 'retry' },
  network: { title: 'Can’t reach the kitchen', body: 'Check your connection. The AI server laptop and its tunnel have to be running.', action: 'retry' },
  bad_response: { title: 'Unexpected answer', body: 'The server sent something the app didn’t understand. Try again, and tell the team if it keeps happening.', action: 'retry' },
  config: { title: 'App isn’t configured', body: 'Some EXPO_PUBLIC_* settings are missing. See app/README.md.', action: 'retry' },
};

/** 503 when the kitchen itself is down, distinct from the auth-service 503. */
const SERVER_DOWN: ErrorCopy = {
  title: 'The kitchen is unavailable',
  body: 'The AI server can’t take that request right now. Try again in a moment.',
  action: 'retry',
};

/** 503 GENERATION_RATE_LIMIT_UNAVAILABLE: a new recipe was not started. */
const NEW_RECIPES_PAUSED: ErrorCopy = {
  title: 'New recipes are paused',
  body: 'The kitchen can’t start a new recipe right now. Try again in a moment, or open a dish you already saved.',
  action: 'retry',
};

/**
 * Auth 503s send no `code`. The AI server uses one of:
 * "Authentication service unavailable" (check-in, mastery, dish photos)
 * "Authentication service temporarily unavailable" (recipe, Cook anything).
 * Match the wording until a code exists. Do not invent one here.
 */
function isAuthUnavailable(message: string): boolean {
  return /authentication/i.test(message);
}

export function errorCopy(e: unknown): ErrorCopy {
  if (isApiError(e)) {
    if (e.kind === 'timeout') return COPY.timeout;
    if (e.code === 'GENERATION_RATE_LIMIT_UNAVAILABLE') return NEW_RECIPES_PAUSED;
    if (e.kind === 'unavailable' && !isAuthUnavailable(e.message)) return SERVER_DOWN;
    const base = COPY[e.kind];
    if (e.kind === 'rate_limited' && e.code === 'email_rate_limited') {
      return { ...base, title: 'Too many emails', body: PASSWORD_RESET_EMAIL_LIMIT_COPY };
    }
    // Validation messages from auth are specific and safe to show as-is.
    return e.kind === 'validation' && e.message ? { ...base, body: e.message } : base;
  }
  return { title: 'Something went wrong', body: e instanceof Error ? e.message : 'Unknown error.', action: 'retry' };
}

/**
 * True when an AI-server call failed because it was unreachable, timed out,
 * or returned 429 / 503. Other failures (a bad recipe, a locked slot) are not
 * outages. Screens that already show `errorCopy` for every error do not need
 * this; Today uses it so a dish-photo miss still falls back quietly.
 */
export function isAiServerOutage(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'rate_limited' || e.kind === 'unavailable') return true;
  return e.status === 503;
}
