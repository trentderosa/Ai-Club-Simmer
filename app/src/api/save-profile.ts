/**
 * Saves the onboarding answers, then asks the database to re-pick dishes for
 * the slots the user hasn't started. Personalizing is best effort: an older
 * database without personalize_my_path, a network blip or any other failure
 * must not block the user (the result says what worked), who simply keeps the canonical dishes. Nothing from
 * the error is logged, so no tokens or profile data can leak.
 */
import type { Backend } from './backend';
import type { ProfileInput } from './schemas';

export interface SaveProfileResult {
  /** The path was re-picked, so cached recipes for unstarted slots are stale. */
  personalized: boolean;
  /** False when the database couldn't store the taste answers (older deploy). */
  tasteSaved: boolean;
}

export async function saveProfileAndPersonalize(backend: Backend, userId: string, input: ProfileInput): Promise<SaveProfileResult> {
  const { tasteSaved } = await backend.saveOnboarding(userId, input); // a failed save still surfaces to the form
  try {
    await backend.personalizeMyPath();
    return { personalized: true, tasteSaved };
  } catch {
    return { personalized: false, tasteSaved }; // fall back to the canonical dishes
  }
}

export const TASTE_NOT_SAVED_NOTICE = 'We couldn’t save your food preferences yet. Your path uses our standard dishes for now — try again later.';
