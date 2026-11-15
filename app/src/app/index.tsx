/** Entry: send the user wherever their session status says they belong. */
import { Redirect } from 'expo-router';

import { useSession } from '../state/session';

export default function Index() {
  const { status } = useSession();
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  if (status === 'needs_onboarding') return <Redirect href="/onboarding" />;
  return <Redirect href="/today" />;
}
