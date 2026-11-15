/**
 * Check-in for a free-form generated recipe. Same form as the path check-in,
 * but posts generated_recipe_id and reuses one idempotency key on Retry.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import type { CookAnythingResponse, PlanSummary, Rating } from '../../api';
import { isApiError } from '../../api';
import { Button, IconButton } from '../../components/button';
import { Field, Segmented, type SegmentOption } from '../../components/choice';
import { gutter, Screen, TopBar } from '../../components/layout';
import { ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import { newIdempotencyKey, SLOW_CHECK_IN_HINT, SLOW_CHECK_IN_HINT_MS } from '../../domain/check-in-retry';
import { errorCopy } from '../../domain/error-messages';
import { useFlowCache } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { useErrorAction } from '../../state/use-error-action';
import { useGeneratedRecipe } from '../../state/use-generated-recipe';
import { color, radius, space } from '../../theme/tokens';

const RATINGS: readonly SegmentOption<Rating>[] = [
  { value: 'easy', title: 'Easy', subtitle: 'Nailed it' },
  { value: 'ok', title: 'OK', subtitle: 'Mostly fine' },
  { value: 'hard', title: 'Hard', subtitle: 'Rough going' },
];
const MAX = 500;

function param(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default function GeneratedCheckIn() {
  const recipeId = param(useLocalSearchParams<{ recipeId: string }>().recipeId);
  const router = useRouter();
  const data = useGeneratedRecipe(recipeId);
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
    <GeneratedCheckInForm
      recipe={data.data}
      onBack={back}
      onDone={() => router.replace({ pathname: '/generated-complete/[recipeId]', params: { recipeId: data.data.generated_recipe_id } })}
    />
  );
}

function GeneratedCheckInForm({
  recipe,
  onBack,
  onDone,
}: {
  recipe: CookAnythingResponse;
  onBack: () => void;
  onDone: () => void;
}) {
  const { backend, requireSession, signOut } = useSession();
  const cache = useFlowCache();
  const [rating, setRating] = useState<Rating | null>(null);
  const [wentWell, setWentWell] = useState('');
  const [wasHard, setWasHard] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [slowHint, setSlowHint] = useState(false);

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
      const response = await backend.submitCheckIn(
        {
          generated_recipe_id: recipe.generated_recipe_id,
          rating,
          went_well: wentWell.trim() || undefined,
          was_hard: wasHard.trim() || undefined,
          idempotency_key: idempotencyKey,
        },
        session.accessToken,
      );
      const after = await backend.getPlanSummary().catch(() => null);
      if (after) cache.setSummary(after);
      cache.setGeneratedOutcome({
        recipe,
        response,
        summaryBefore,
        summaryAfter: after,
      });
      onDone();
    } catch (e) {
      if (isApiError(e) && e.kind === 'unauthorized') {
        void signOut();
        return;
      }
      setError(errorCopy(e).body);
      setSlowHint(false);
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen footer={<Button label="Save check-in" onPress={() => void submit()} disabled={!rating} loading={saving} style={{ flex: 1 }} />}>
        <TopBar left={<IconButton icon="back" label="Back to cook mode" onPress={onBack} />} title="Check-in" />
        <View style={[gutter, { marginTop: 6 }]}>
          <T variant="h1" accessibilityRole="header">
            How did the {recipe.recipe.title.toLowerCase()} go?
          </T>
          <T variant="small" style={{ marginTop: 8 }}>
            Thirty seconds. Your coach uses this the next time you cook this dish.
          </T>
          <Segmented options={RATINGS} value={rating} onChange={setRating} />
          <Field label="What went well?" hint="Optional" value={wentWell} onChangeText={setWentWell} multiline maxLength={MAX} placeholder="The noodles didn’t clump" />
          <Counter text={wentWell} />
          <Field label="What was hard?" hint="Optional" value={wasHard} onChangeText={setWasHard} multiline maxLength={MAX} placeholder="Timing the sauce" />
          <Counter text={wasHard} />
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
