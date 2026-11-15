/**
 * Check-in (F6). Body matches POST /api/check-ins: rating + two optional
 * notes. `user_recipe_id` comes from `user_recipes` (RLS: own rows only).
 * The summary is read just before and after so the next screen can show
 * "239 -> 382 total" from real numbers, not arithmetic.
 *
 * Each visit mints one `idempotency_key` and reuses it on Retry so a
 * timed-out POST cannot award XP twice. After a network/timeout error the
 * screen re-reads `get_my_plan()` and, if `times_completed` went up, goes
 * to Complete without posting again.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import type { PlanSlot, PlanSummary, Rating, Recipe } from '../../api';
import { Button, IconButton } from '../../components/button';
import { Field, Segmented, type SegmentOption } from '../../components/choice';
import { gutter, Screen, TopBar } from '../../components/layout';
import { ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import {
  didCheckInLand,
  newIdempotencyKey,
  responseForLandedCheckIn,
  SLOW_CHECK_IN_HINT,
  SLOW_CHECK_IN_HINT_MS,
} from '../../domain/check-in-retry';
import { masteryCountsFromReveals, revealedLabel } from '../../domain/mastery';
import { errorCopy } from '../../domain/error-messages';
import { isApiError } from '../../api';
import { useFlowCache } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { useErrorAction } from '../../state/use-error-action';
import { useSlotRecipe } from '../../state/use-slot-recipe';
import { color, radius, space } from '../../theme/tokens';

const RATINGS: readonly SegmentOption<Rating>[] = [
  { value: 'easy', title: 'Easy', subtitle: 'Nailed it' },
  { value: 'ok', title: 'OK', subtitle: 'Mostly fine' },
  { value: 'hard', title: 'Hard', subtitle: 'Rough going' },
];
const MAX = 500;

export default function CheckIn() {
  const { slotId: raw } = useLocalSearchParams<{ slotId: string }>();
  const slotId = Number(raw);
  const router = useRouter();
  const data = useSlotRecipe(slotId);
  const onError = useErrorAction(data.reload);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  if (data.status !== 'ready') {
    return (
      <Screen>
        <TopBar left={<IconButton icon="back" label="Back" onPress={back} />} title="Check-in" />
        {data.status === 'error' ? <ErrorState error={data.error} onAction={onError} /> : <LoadingState />}
      </Screen>
    );
  }
  return (
    <CheckInForm
      slot={data.data.slot}
      recipe={data.data.recipe.recipe}
      onBack={back}
      onDone={() => router.replace({ pathname: '/complete/[slotId]', params: { slotId: String(slotId) } })}
    />
  );
}

function CheckInForm({ slot, recipe, onBack, onDone }: { slot: PlanSlot; recipe: Recipe; onBack: () => void; onDone: () => void }) {
  const { backend, requireSession, signOut } = useSession();
  const cache = useFlowCache();
  const [rating, setRating] = useState<Rating | null>(null);
  const [wentWell, setWentWell] = useState('');
  const [wasHard, setWasHard] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [slowHint, setSlowHint] = useState(false);
  const mastery = slot.is_final
    ? (cache.getMastery(slot.slot_id) ?? masteryCountsFromReveals(recipe.steps, []))
    : undefined;

  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSlowHint(true), SLOW_CHECK_IN_HINT_MS);
    return () => clearTimeout(timer);
  }, [saving]);

  async function submit() {
    if (!rating) return;
    setSaving(true);
    setSlowHint(false);
    setError(null);
    let summaryBefore: PlanSummary | null = null;
    try {
      const session = requireSession();
      summaryBefore = await backend.getPlanSummary().catch(() => null);
      const userRecipeId = await backend.getUserRecipeId(slot.slot_id);
      const response = await backend.submitCheckIn(
        {
          user_recipe_id: userRecipeId,
          slot_id: slot.slot_id,
          rating,
          went_well: wentWell.trim() || undefined,
          was_hard: wasHard.trim() || undefined,
          mastery,
          idempotency_key: idempotencyKey,
        },
        session.accessToken,
      );
      // The check-in is saved. These re-reads only feed the celebration screen.
      const [after, plan] = await Promise.allSettled([backend.getPlanSummary(), backend.getPlan()]);
      const planAfter = plan.status === 'fulfilled' ? plan.value : null;
      if (planAfter) cache.setPlan(planAfter);
      cache.setOutcome({
        slot,
        response,
        summaryBefore,
        summaryAfter: after.status === 'fulfilled' ? after.value : null,
        planAfter,
      });
      onDone();
    } catch (e) {
      if (isApiError(e) && e.kind === 'unauthorized') {
        void signOut();
        return;
      }
      if (isApiError(e) && e.kind === 'network') {
        const recovered = await recoverIfLanded(idempotencyKey, rating, summaryBefore);
        if (recovered) return;
      }
      setError(errorCopy(e).body);
      setSlowHint(false);
      setSaving(false);
    }
  }

  async function recoverIfLanded(
    idempotencyKey: string,
    submittedRating: Rating,
    summaryBefore: PlanSummary | null,
  ): Promise<boolean> {
    try {
      const [plan, summaryAfter] = await Promise.all([
        backend.getPlan(),
        backend.getPlanSummary().catch(() => null),
      ]);
      const slotAfter = plan.find((s) => s.slot_id === slot.slot_id);
      if (!didCheckInLand(slot.times_completed, slotAfter)) return false;
      cache.setPlan(plan);
      cache.setOutcome({
        slot,
        response: responseForLandedCheckIn({
          idempotencyKey,
          rating: submittedRating,
          summaryBefore,
          summaryAfter,
          timesCompletedBefore: slot.times_completed,
        }),
        summaryBefore,
        summaryAfter,
        planAfter: plan,
      });
      onDone();
      return true;
    } catch {
      return false;
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen footer={<Button label="Save check-in" onPress={() => void submit()} disabled={!rating} loading={saving} style={{ flex: 1 }} />}>
        <TopBar left={<IconButton icon="back" label="Back to cook mode" onPress={onBack} />} title="Check-in" />
        <View style={[gutter, { marginTop: 6 }]}>
          <T variant="h1" accessibilityRole="header">
            How did the {slot.dish_name.toLowerCase()} go?
          </T>
          <T variant="small" style={{ marginTop: 8 }}>
            Thirty seconds. Your coach uses this to write the next recipe for you.
          </T>
          {mastery ? (
            <T variant="caption" style={{ marginTop: 10 }}>
              Mastery challenge · {revealedLabel(mastery)}
            </T>
          ) : null}
          <Segmented options={RATINGS} value={rating} onChange={setRating} />
          <Field label="What went well?" hint="Optional" value={wentWell} onChangeText={setWentWell} multiline maxLength={MAX} placeholder="The rice came out fluffy" />
          <Counter text={wentWell} />
          <Field label="What was hard?" hint="Optional" value={wasHard} onChangeText={setWasHard} multiline maxLength={MAX} placeholder="Timing the sauce" />
          <Counter text={wasHard} />
          <T variant="caption" style={{ marginTop: 16 }}>
            If you rate it Hard, we’ll offer to cook it again before moving on. Your path never changes.
          </T>
          {slowHint ? (
            <T variant="caption" style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
              {SLOW_CHECK_IN_HINT}
            </T>
          ) : null}
          {error ? (
            <View style={styles.error} accessibilityRole="alert">
              <T variant="small" style={{ color: color.safety }}>
                {error}
              </T>
            </View>
          ) : null}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function Counter({ text }: { text: string }) {
  if (text.length < MAX - 100) return null;
  return (
    <T variant="caption" style={{ marginTop: 4, textAlign: 'right' }}>
      {MAX - text.length} characters left
    </T>
  );
}

const styles = StyleSheet.create({
  error: { marginTop: space.s4, padding: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: color.safety, backgroundColor: color.safetyWash },
});
