/**
 * Session complete for a free-form generated recipe. XP comes from the
 * check-in response plus the summary re-read right after it.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { Button, IconButton } from '../../components/button';
import { gutter, Rule, Screen, TopBar } from '../../components/layout';
import { PotIllustration } from '../../components/pot';
import { EmptyState } from '../../components/states';
import { T } from '../../components/text';
import { formatXpGain, toXpView } from '../../domain/xp-result';
import { useFlowCache, type GeneratedCheckInOutcome } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { color, font, space } from '../../theme/tokens';

function param(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default function GeneratedComplete() {
  const recipeId = param(useLocalSearchParams<{ recipeId: string }>().recipeId);
  const router = useRouter();
  const outcome = useFlowCache().getGeneratedOutcome(recipeId ?? '');
  const home = () => router.dismissTo('/today');

  if (!outcome) {
    return (
      <Screen>
        <TopBar right={<IconButton icon="x" label="Close" onPress={home} />} />
        <EmptyState title="Nothing to celebrate here yet" body="Finish a recipe and its check-in, and the result shows up here." action={{ label: 'Back to my path', onPress: home }} />
      </Screen>
    );
  }
  return (
    <Result
      outcome={outcome}
      onHome={home}
      onCookAgain={() => router.replace({ pathname: '/generated/[recipeId]', params: { recipeId: outcome.recipe.generated_recipe_id } })}
    />
  );
}

function Result({
  outcome,
  onHome,
  onCookAgain,
}: {
  outcome: GeneratedCheckInOutcome;
  onHome: () => void;
  onCookAgain: () => void;
}) {
  const { session } = useSession();
  const { recipe, response, summaryBefore, summaryAfter } = outcome;
  const xp = toXpView(response.xp, recipe.xp_value);
  const gain = formatXpGain(xp);
  const name = session?.firstName;
  const title = recipe.recipe.title;

  return (
    <Screen footer={<Button label="Back to my path" kind="ink" onPress={onHome} style={{ flex: 1 }} />}>
      <TopBar right={<IconButton icon="x" label="Close" onPress={onHome} />} />
      <View style={{ alignItems: 'center', marginTop: -8 }}>
        <PotIllustration />
        <T variant="overline" style={{ marginTop: 6 }}>
          Cook anything, done
        </T>
        <T variant="h1" style={[gutter, styles.center, { marginTop: 6 }]} accessibilityRole="header">
          {name ? `You made ${title}, ${name}.` : `You made ${title}.`}
        </T>
      </View>

      {gain ? (
        <>
          <View style={styles.xpRow} accessibilityLabel={`${gain} XP`}>
            <CountUp to={xp.kind === 'first' || xp.kind === 'repeat' ? xp.amount : 0} />
            <T style={styles.xpUnit}>XP</T>
          </View>
          {summaryBefore && summaryAfter ? (
            <T variant="caption" style={[styles.center, { fontSize: 14 }]}>
              {summaryBefore.total_xp} →{' '}
              <T variant="caption" style={styles.strong}>
                {summaryAfter.total_xp}
              </T>{' '}
              total
            </T>
          ) : null}
          {xp.note ? (
            <T variant="small" style={[gutter, styles.center, { marginTop: 8 }]}>
              {xp.note}
            </T>
          ) : null}
        </>
      ) : (
        <View style={styles.pending}>
          <T variant="overline" color="ink3">
            {xp.kind === 'pending' ? 'XP on its way' : 'No XP on this server'}
          </T>
          <T variant="body" style={{ marginTop: 6 }}>
            {xp.note}
          </T>
        </View>
      )}

      <View style={[gutter, { marginTop: 18 }]}>
        <Rule strong style={{ marginBottom: 18 }} />
        <T variant="overline" color="ink3">
          Your coach
        </T>
        <T style={styles.reply}>{response.coach_note}</T>
        {response.focus_area ? (
          <T variant="caption" style={styles.focus}>
            Focus next: <T style={styles.focusArea}>{response.focus_area}</T>
          </T>
        ) : null}
      </View>

      {response.suggest_repeat ? (
        <View style={[gutter, styles.repeat]}>
          <T variant="h3">That one was tough. Cook it again?</T>
          <T variant="caption" style={{ marginTop: 4 }}>
            You’ll get the same recipe, and half XP on a repeat.
          </T>
          <View style={styles.repeatButtons}>
            <Button label="Cook again" kind="outline" onPress={onCookAgain} style={{ flex: 1 }} />
            <Button label="Skip" kind="quiet" onPress={onHome} style={{ flex: 1, height: 54 }} />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

function CountUp({ to }: { to: number }) {
  const [n, setN] = useState(0);
  const raf = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!alive) return;
      if (reduce || to <= 0) {
        setN(to);
        return;
      }
      const start = Date.now();
      raf.current = setInterval(() => {
        const p = Math.min(1, (Date.now() - start) / 500);
        setN(Math.round(to * p));
        if (p >= 1 && raf.current) clearInterval(raf.current);
      }, 16);
    });
    return () => {
      alive = false;
      if (raf.current) clearInterval(raf.current);
    };
  }, [to]);
  return <T variant="xpHero">+{n}</T>;
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  xpRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8, marginTop: 6 },
  xpUnit: { fontFamily: font.bodyBold, fontSize: 14, letterSpacing: 2, color: color.ink2 },
  strong: { fontFamily: font.bodyBold, color: color.ink, fontSize: 14 },
  pending: { marginTop: 18, marginHorizontal: space.gutter, paddingVertical: 14, borderTopWidth: 1, borderTopColor: color.rule },
  reply: { fontFamily: font.displayRegular, fontSize: 17, lineHeight: 25, marginTop: 6, color: color.ink },
  focus: { marginTop: 10, fontFamily: font.bodySemi, color: color.ink2 },
  focusArea: { fontFamily: font.bodyBold, fontSize: 13, color: color.tomatoDeep },
  repeat: { marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: color.ink },
  repeatButtons: { flexDirection: 'row', gap: 12, marginTop: 14 },
});
