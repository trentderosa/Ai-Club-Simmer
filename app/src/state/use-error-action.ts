import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import type { ErrorAction } from '../domain/error-messages';
import { useSession } from './session';

/** Default handler for ErrorState buttons; `retry` is screen-specific. */
export function useErrorAction(retry: () => void) {
  const router = useRouter();
  const { signOut, refreshProfile } = useSession();
  return useCallback(
    (action: ErrorAction) => {
      if (action === 'retry') retry();
      else if (action === 'sign_in') void signOut();
      // Re-reading the profile flips status to needs_onboarding; the root guard re-routes.
      else if (action === 'onboarding') void refreshProfile();
      else router.replace('/today');
    },
    [retry, signOut, refreshProfile, router],
  );
}
