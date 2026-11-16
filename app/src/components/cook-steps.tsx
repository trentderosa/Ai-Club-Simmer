/**
 * Shared cook-mode stepper used by path slots and free-form generated recipes.
 * With `mastery` (slot 10, F8), non-safety steps start hidden and can be
 * revealed one at a time. The server masks hidden steps; a reveal asks the
 * server, which records it, for the step's real content. Safety steps
 * (`isSafetyStep`) stay visible.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Recipe, RecipeStep, Videos } from '../api';
import { color, font, radius, space } from '../theme/tokens';
import { highlightIngredients } from '../domain/highlight';
import { errorCopy } from '../domain/error-messages';
import { countsForRun, displayStep, isStepHidden, revealedLabel, type MasteryRun } from '../domain/mastery';
import { createTimer, parseStepDurationSeconds, type TimerState } from '../domain/timer';
import { useSession } from '../state/session';
import { Button, IconButton } from './button';
import { Icon } from './icon';
import { T } from './text';
import { TimerCard } from './timer-card';
import { VideoRow } from './video';

export interface MasteryControls {
  run: MasteryRun;
  /** Ask the server for step `index`; resolves with the updated run. */
  reveal: (index: number) => Promise<MasteryRun>;
}

export function CookSteps({
  recipe,
  videos,
  onClose,
  onDone,
  mastery,
}: {
  recipe: Recipe;
  videos: Videos;
  onClose: () => void;
  onDone: () => void;
  /** Final path slot (F8): the server-side mastery run and how to reveal a step. */
  mastery?: MasteryControls;
}) {
  const insets = useSafeAreaInsets();
  const { backend } = useSession();
  const [index, setIndex] = useState(0);
  const [showIngredients, setShowIngredients] = useState(false);
  const [run, setRun] = useState<MasteryRun | null>(mastery?.run ?? null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  // One timer per step that names a duration; they keep running when you move between steps.
  // A hidden step's timer appears once it is revealed.
  const [timers, setTimers] = useState<Record<number, TimerState>>(() => {
    const out: Record<number, TimerState> = {};
    recipe.steps.forEach((_, i) => {
      if (isStepHidden(mastery?.run ?? null, i)) return;
      const secs = parseStepDurationSeconds(displayStep(recipe, mastery?.run ?? null, i).instruction);
      if (secs) out[i] = createTimer(secs);
    });
    return out;
  });
  const setTimer = useCallback((i: number, t: TimerState) => setTimers((prev) => ({ ...prev, [i]: t })), []);

  const step = displayStep(recipe, run, index);
  const total = recipe.steps.length;
  const last = index === total - 1;
  const video = step.techniqueName ? videos[step.techniqueName] : undefined;
  const counts = useMemo(() => (run ? countsForRun(run) : null), [run]);
  const hidden = isStepHidden(run, index);

  const revealStep = async () => {
    if (!mastery || revealing) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const next = await mastery.reveal(index);
      setRun(next);
      const revealedStep = next.revealed[index];
      const secs = revealedStep ? parseStepDurationSeconds(revealedStep.instruction) : null;
      if (secs) setTimers((prev) => (prev[index] ? prev : { ...prev, [index]: createTimer(secs) }));
    } catch (e) {
      setRevealError(errorCopy(e).body);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.fill}>
      <View style={styles.top}>
        <IconButton icon="x" label="Close cook mode" onPress={onClose} />
        <T variant="byline" color="ink3" numberOfLines={1} style={styles.topTitle}>
          {recipe.title}
        </T>
        <IconButton icon="list" label={showIngredients ? 'Show the step' : 'Show ingredients'} onPress={() => setShowIngredients((v) => !v)} />
      </View>
      <View style={styles.ticks} accessibilityLabel={`Step ${index + 1} of ${total}`}>
        {recipe.steps.map((_, i) => (
          <View key={i} style={[styles.tick, i < index && styles.tickDone, i === index && styles.tickOn]} />
        ))}
      </View>

      {counts ? (
        <View style={styles.challengeHead} accessibilityLabel={revealedLabel(counts)}>
          <T variant="overline" color="ink3">
            Mastery challenge
          </T>
          <T variant="caption" style={{ marginTop: 4 }}>
            {revealedLabel(counts)}
          </T>
          <T variant="caption" style={{ marginTop: 6 }}>
            Reveal a step and you’ll still finish, but the mastery seal needs zero reveals.
          </T>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        {showIngredients ? (
          <IngredientsPanel recipe={recipe} />
        ) : (
          <>
            <View style={styles.stepNum}>
              <T variant="stepNumber">{index + 1}</T>
              <T style={styles.of}>of {total}</T>
            </View>
            {hidden ? (
              <HiddenStep index={index} total={total} onReveal={() => void revealStep()} loading={revealing} error={revealError} />
            ) : (
              <>
            <Instruction step={step} recipe={recipe} />
            {step.whyItMatters ? (
              <View style={styles.why}>
                <T variant="body" style={styles.whyText}>
                  <T variant="bodySemi" style={styles.whyLead}>
                    Why it matters.{' '}
                  </T>
                  {step.whyItMatters}
                </T>
              </View>
            ) : null}
            {step.isSafetyStep ? (
              <View style={styles.safety} accessibilityRole="alert">
                <Icon name="alert" color={color.safety} size={20} />
                <View style={{ flex: 1 }}>
                  <T style={styles.safetyLabel}>Safety</T>
                  <T style={styles.safetyText}>Heat, a blade, or raw meat on this step. Slow down and keep your hands clear.</T>
                </View>
              </View>
            ) : null}
            {video ? <VideoRow compact video={video} placeholder={backend.label !== 'live'} caption={backend.label !== 'live' ? 'Placeholder video' : 'YouTube'} /> : null}
            {timers[index] ? <TimerCard timer={timers[index]} onChange={(t) => setTimer(index, t)} /> : null}
              </>
            )}
          </>
        )}
      </ScrollView>

      <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 14) + 14 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous step"
          accessibilityState={{ disabled: index === 0 }}
          disabled={index === 0}
          onPress={() => {
            setShowIngredients(false);
            setRevealError(null);
            setIndex(index - 1);
          }}
          style={({ pressed }) => [styles.backBtn, index === 0 && { opacity: 0.35 }, pressed && { opacity: 0.7 }]}
        >
          <Icon name="back" size={28} />
        </Pressable>
        <Button
          size="large"
          label={last ? 'Done cooking' : 'Next step'}
          trailingIcon={last ? 'check' : 'arrow'}
          onPress={() => {
            setShowIngredients(false);
            setRevealError(null);
            if (last) onDone();
            else setIndex(index + 1);
          }}
          style={{ flex: 1 }}
        />
      </View>
    </SafeAreaView>
  );
}

function HiddenStep({
  index,
  total,
  onReveal,
  loading,
  error,
}: {
  index: number;
  total: number;
  onReveal: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <View style={styles.hidden}>
      <T variant="overline" color="ink3">
        Hidden step
      </T>
      <T variant="body" style={{ marginTop: 8 }}>
        This step starts hidden. Reveal it only if you need a reminder.
      </T>
      <Button
        kind="outline"
        label="Reveal"
        onPress={onReveal}
        loading={loading}
        accessibilityHint={`Reveal step ${index + 1} of ${total}`}
        style={{ marginTop: 16, alignSelf: 'flex-start' }}
      />
      {error ? (
        <T variant="caption" style={{ marginTop: 10, color: color.safety }} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}
    </View>
  );
}

function Instruction({ step, recipe }: { step: RecipeStep; recipe: Recipe }) {
  const runs = useMemo(() => highlightIngredients(step.instruction, recipe.ingredients), [step.instruction, recipe.ingredients]);
  return (
    <T variant="cookStep" style={{ marginTop: 20 }} accessibilityLabel={step.instruction}>
      {runs.map((r, i) =>
        r.highlight ? (
          <T key={i} variant="cookStep" style={styles.mark}>
            {r.text}
          </T>
        ) : (
          r.text
        ),
      )}
    </T>
  );
}

function IngredientsPanel({ recipe }: { recipe: Recipe }) {
  return (
    <View style={{ paddingTop: 10 }}>
      <T variant="h2" style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: color.ink }}>
        Ingredients
      </T>
      {recipe.ingredients.map((ing, i) => (
        <View key={`${ing.name}-${i}`} style={styles.ing}>
          <T variant="bodySemi" style={{ width: 96, paddingRight: 10 }}>
            {ing.amount}
          </T>
          <T style={{ flex: 1 }}>{ing.name}</T>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.sheet },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingTop: 4, minHeight: 48 },
  topTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8 },
  ticks: { flexDirection: 'row', gap: 5, paddingTop: 14, paddingHorizontal: space.gutter },
  tick: { flex: 1, height: 4, borderRadius: 2, backgroundColor: color.rule },
  tickDone: { backgroundColor: color.ink },
  tickOn: { backgroundColor: color.tomato },
  challengeHead: { paddingHorizontal: space.gutter, paddingTop: 16 },
  hidden: { marginTop: 20, borderWidth: 1, borderColor: color.ink, borderRadius: radius.md, paddingVertical: 16, paddingHorizontal: 16, backgroundColor: color.paper },
  body: { paddingHorizontal: space.gutter, paddingTop: 30, paddingBottom: 24 },
  stepNum: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  of: { fontFamily: font.bodySemi, fontSize: 15, color: color.ink3 },
  mark: { color: color.tomatoDeep, textDecorationLine: 'underline', textDecorationColor: color.tomatoWash },
  why: { marginTop: 18, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: color.butter },
  whyText: { fontSize: 16, lineHeight: 23, color: color.ink2 },
  whyLead: { fontSize: 16, lineHeight: 23, fontFamily: font.bodyBold, color: color.ink },
  safety: { marginTop: 18, flexDirection: 'row', gap: 8, borderWidth: 1.5, borderColor: color.safety, backgroundColor: color.safetyWash, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 12 },
  safetyLabel: { fontFamily: font.bodyBold, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', color: color.safety },
  safetyText: { fontFamily: font.body, fontSize: 15, lineHeight: 20, color: color.safety },
  ing: { flexDirection: 'row', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: color.ruleSoft },
  foot: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10, backgroundColor: color.sheet },
  backBtn: { width: 96, height: 72, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.rule, alignItems: 'center', justifyContent: 'center' },
});
