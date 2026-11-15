/**
 * Cook mode (F5): one step at a time, big type for arm's length, ingredient
 * words highlighted, a "why it matters" line, a safety box on safety steps,
 * the step's video (if any), and an inline timer when the step names a time.
 * The last step's button is "Done cooking", which opens the check-in (F6).
 * Slot 10 (is_final) opens F8 mastery mode: non-safety steps start hidden.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton } from '../../components/button';
import { CookSteps } from '../../components/cook-steps';
import { ErrorState, LoadingState } from '../../components/states';
import { useFlowCache } from '../../state/flow-cache';
import { useErrorAction } from '../../state/use-error-action';
import { useSlotRecipe } from '../../state/use-slot-recipe';
import { color } from '../../theme/tokens';

export default function CookMode() {
  const { slotId: raw } = useLocalSearchParams<{ slotId: string }>();
  const slotId = Number(raw);
  const router = useRouter();
  const data = useSlotRecipe(slotId);
  const cache = useFlowCache();
  const onError = useErrorAction(data.reload);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  if (data.status !== 'ready') {
    return (
      <SafeAreaView style={styles.fill}>
        <View style={styles.top}>
          <IconButton icon="x" label="Close cook mode" onPress={close} />
        </View>
        {data.status === 'error' ? <ErrorState error={data.error} onAction={onError} /> : <LoadingState title="Getting your station ready…" />}
      </SafeAreaView>
    );
  }
  return (
    <CookSteps
      recipe={data.data.recipe.recipe}
      videos={data.data.recipe.videos}
      challenge={data.data.slot.is_final}
      initialRevealed={data.data.slot.is_final ? (cache.getMastery(slotId)?.revealedIndices ?? []) : undefined}
      onMasteryChange={data.data.slot.is_final ? (session) => cache.setMastery(slotId, session) : undefined}
      onClose={close}
      onDone={() => router.replace({ pathname: '/check-in/[slotId]', params: { slotId: String(slotId) } })}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.sheet },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingTop: 4, minHeight: 48 },
});
