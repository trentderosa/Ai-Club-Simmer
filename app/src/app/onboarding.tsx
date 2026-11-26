/**
 * Onboarding (F1), steps 2-5 of 5 (step 1 is the account). Saves to
 * `profiles`, then asks the database to pick dishes for the user's tastes.
 */
import { useState } from 'react';

import type { ProfileInput } from '../api';
import { saveProfileAndPersonalize, TASTE_NOT_SAVED_NOTICE } from '../api/save-profile';
import { OnboardingForm } from '../components/onboarding-form';
import { errorCopy } from '../domain/error-messages';
import { useFlowCache } from '../state/flow-cache';
import { useSession } from '../state/session';

export default function Onboarding() {
  const { backend, requireSession, refreshProfile, signOut } = useSession();
  const cache = useFlowCache();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(input: ProfileInput) {
    setSaving(true);
    setError(null);
    try {
      const session = requireSession();
      const result = await saveProfileAndPersonalize(backend, session.userId, input);
      if (result.personalized) cache.invalidateUnstarted();
      cache.setNotice(result.tasteSaved ? null : TASTE_NOT_SAVED_NOTICE); // shown on Today
      await refreshProfile(); // flips status to ready; the root guard moves on to Today
    } catch (e) {
      setError(errorCopy(e).body);
      setSaving(false);
    }
  }

  return <OnboardingForm mode="create" saving={saving} error={error} onSave={(input) => void save(input)} onSignOut={() => void signOut()} />;
}
