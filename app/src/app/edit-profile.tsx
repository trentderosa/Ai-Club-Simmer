/**
 * Edit onboarding answers from the profile. Reuses the same steps and
 * writes the same `profiles` columns (no name column), then re-personalizes
 * the path. Today re-reads the plan when it regains focus.
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import type { ProfileInput } from '../api';
import { saveProfileAndPersonalize, TASTE_NOT_SAVED_NOTICE } from '../api/save-profile';
import { OnboardingForm } from '../components/onboarding-form';
import { ErrorState, LoadingState } from '../components/states';
import { errorCopy } from '../domain/error-messages';
import { useFlowCache } from '../state/flow-cache';
import { useSession } from '../state/session';
import { useAsync } from '../state/use-async';
import { useErrorAction } from '../state/use-error-action';
import { color } from '../theme/tokens';

export default function EditProfile() {
  const router = useRouter();
  const { backend, requireSession, refreshProfile } = useSession();
  const cache = useFlowCache();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile' as Href));

  const data = useAsync(async () => {
    const session = requireSession();
    return backend.getProfile(session.userId);
  }, [backend]);
  const onError = useErrorAction(data.reload);

  async function save(input: ProfileInput) {
    setSaving(true);
    setError(null);
    try {
      const session = requireSession();
      const result = await saveProfileAndPersonalize(backend, session.userId, input);
      if (result.personalized) cache.invalidateUnstarted();
      cache.setNotice(result.tasteSaved ? null : TASTE_NOT_SAVED_NOTICE); // shown on Today
      await refreshProfile();
      back();
    } catch (e) {
      setError(errorCopy(e).body);
      setSaving(false);
    }
  }

  if (data.status !== 'ready') {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        {data.status === 'error' ? <ErrorState error={data.error} onAction={onError} secondary={{ label: 'Back', onPress: back }} /> : <LoadingState title="Loading your answers…" />}
      </View>
    );
  }

  return <OnboardingForm mode="edit" initial={data.data} saving={saving} error={error} onSave={(input) => void save(input)} onCancel={back} />;
}
