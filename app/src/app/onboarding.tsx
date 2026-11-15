/**
 * Onboarding (F1), steps 2-4 of 4 (step 1 is the account). Saves to
 * `profiles` with the columns that exist today. The diet question from the
 * mockup is left out because there's no column for it yet.
 */
import { useState } from 'react';

import type { ProfileInput } from '../api';
import { OnboardingForm } from '../components/onboarding-form';
import { errorCopy } from '../domain/error-messages';
import { useSession } from '../state/session';

export default function Onboarding() {
  const { backend, requireSession, refreshProfile, signOut } = useSession();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(input: ProfileInput) {
    setSaving(true);
    setError(null);
    try {
      const session = requireSession();
      await backend.saveOnboarding(session.userId, input);
      await refreshProfile(); // flips status to ready; the root guard moves on to Today
    } catch (e) {
      setError(errorCopy(e).body);
      setSaving(false);
    }
  }

  return <OnboardingForm mode="create" saving={saving} error={error} onSave={(input) => void save(input)} onSignOut={() => void signOut()} />;
}
