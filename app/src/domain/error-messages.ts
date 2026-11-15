/**
 * User-facing copy for every ApiError kind (per docs/CLIENT_API.md error
 * lists). Screens pick the action button from `action`.
 */
import { isApiError, type ApiErrorKind } from '../api/errors';

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
  validation: { title: 'Something’s off with that', body: 'Some of the details weren’t accepted. Check them and try again.', action: 'retry' },
  unavailable: { title: 'Sign-in service is down', body: 'The server couldn’t check your login just now. Try again in a moment.', action: 'retry' },
  server: { title: 'Something went wrong', body: 'The server hit an error. Try again in a moment.', action: 'retry' },
  network: { title: 'Can’t reach the kitchen', body: 'Check your connection. Recipes come from the AI server laptop, so it has to be running and on the same network.', action: 'retry' },
  bad_response: { title: 'Unexpected answer', body: 'The server sent something the app didn’t understand. Try again, and tell the team if it keeps happening.', action: 'retry' },
  config: { title: 'App isn’t configured', body: 'Some EXPO_PUBLIC_* settings are missing. See app/README.md.', action: 'retry' },
};

export function errorCopy(e: unknown): ErrorCopy {
  if (isApiError(e)) {
    const base = COPY[e.kind];
    // Validation messages from auth are specific and safe to show as-is.
    return e.kind === 'validation' && e.message ? { ...base, body: e.message } : base;
  }
  return { title: 'Something went wrong', body: e instanceof Error ? e.message : 'Unknown error.', action: 'retry' };
}
