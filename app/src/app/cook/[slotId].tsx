/**
 * Cook mode (F5): one step at a time, big type for arm's length, ingredient
 * words highlighted, a "why it matters" line, a safety box on safety steps,
 * the step's video (if any), and an inline timer when the step names a time.
 * The last step's button is "Done cooking", which opens the check-in (F6).
 *
 * Slot 10 (is_final) opens F8 mastery mode: before showing any step, it
 * starts or resumes the server-side mastery session. The server keeps the
 * reveals, so closing the app or reopening cook mode never resets them.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton } from '../../components/button';
import { CookSteps } from '../../components/cook-steps';
import { ErrorState, LoadingState } from '../../components/states';
import { runFromStart, runWithReveal, type MasteryRun } from '../../domain/mastery';
import { useFlowCache } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { useAsync } from '../../state/use-async';
import { useErrorAction } from '../../state/use-error-action';
import { useSlotRecipe, type SlotRecipe } from '../../state/use-slot-recipe';
import { color } from '../../theme/tokens';

interface CookData extends SlotRecipe {
  /** Final slot only. */
  mastery: MasteryRun | null;
}

export default function CookMode() {
  const { slotId: raw } = useLocalSearchParams<{ slotId: string }>();
  const slotId = Number(raw);
  const router = useRouter();
  const { backend, requireSession } = useSession();
  const recipe = useSlotRecipe(slotId);
  const cache = useFlowCache();

  const ready = recipe.status === 'ready' ? recipe.data : null;
  const data = useAsync<CookData | null>(async () => {
    if (!ready) return null;
    if (!ready.slot.is_final) return { ...ready, mastery: null };
    // Always ask the server: it resumes the open session with its reveals.
    const start = await backend.startMastery(slotId, requireSession().accessToken);
    const run = runFromStart(start);
    cache.setMastery(slotId, run);
    return { ...ready, mastery: run };
  }, [ready, slotId]);

  const reload = () => (recipe.status === 'error' ? recipe.reload() : data.reload());
  const onError = useErrorAction(reload);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  const error = recipe.status === 'error' ? recipe.error : data.status === 'error' ? data.error : null;
  if (data.status !== 'ready' || !data.data) {
    return (
      <SafeAreaView style={styles.fill}>
        <View style={styles.top}>
          <IconButton icon="x" label="Close cook mode" onPress={close} />
        </View>
        {error ? <ErrorState error={error} onAction={onError} /> : <LoadingState title="Getting your station ready…" />}
      </SafeAreaView>
    );
  }

  const { recipe: res, mastery } = data.data;
  return (
    <CookSteps
      recipe={res.recipe}
      videos={res.videos}
      mastery={
        mastery
          ? {
              run: mastery,
              reveal: async (index) => {
                const current = cache.getMastery(slotId) ?? mastery;
                const reveal = await backend.revealMasteryStep(current.sessionId, index, requireSession().accessToken);
                const next = runWithReveal(current, reveal);
                cache.setMastery(slotId, next);
                return next;
              },
            }
          : undefined
      }
      onClose={close}
      onDone={() => router.replace({ pathname: '/check-in/[slotId]', params: { slotId: String(slotId) } })}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.sheet },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingTop: 4, minHeight: 48 },
});
