/**
 * Session complete (F6, F7, F9). Everything comes from the check-in's 201
 * response plus the summary/plan re-read right after it:
 * - xp.awarded -> "+N XP" (count-up), and before -> after totals if both reads worked
 * - xp.failed  -> check-in saved, XP pending; no number
 * - xp.skipped -> check-in saved, XP not configured (dev); no number
 * - badges.earned -> one seal per badge
 * - suggest_repeat -> "Cook it again before moving on?" (cook again / skip)
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { Button, IconButton } from '../../components/button';
import { gutter, Rule, Screen, TopBar } from '../../components/layout';
import { PotIllustration } from '../../components/pot';
import { Seal } from '../../components/seal';
import { EmptyState } from '../../components/states';
import { T } from '../../components/text';
import { formatXpGain, toXpView } from '../../domain/xp-result';
import { useFlowCache, type CheckInOutcome } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { color, font, space } from '../../theme/tokens';

export default function Complete() {
  const { slotId: raw } = useLocalSearchParams<{ slotId: string }>();
  const router = useRouter();
  const outcome = useFlowCache().getOutcome(Number(raw));
  const home = () => router.dismissTo('/today');

  if (!outcome) {
    return (
      <Screen>
        <TopBar right={<IconButton icon="x" label="Close" onPress={home} />} />
        <EmptyState title="Nothing to celebrate here yet" body="Finish a recipe and its check-in, and the result shows up here." action={{ label: 'Back to my path', onPress: home }} />
      </Screen>
    );
  }
  return <Result outcome={outcome} onHome={home} onCookAgain={() => router.replace({ pathname: '/recipe/[slotId]', params: { slotId: raw } })} />;
}

function Result({ outcome, onHome, onCookAgain }: { outcome: CheckInOutcome; onHome: () => void; onCookAgain: () => void }) {
  const { session } = useSession();
  const { slot, response, summaryBefore, summaryAfter, planAfter } = outcome;
  const xp = toXpView(response.xp, slot.xp_value);
  const gain = formatXpGain(xp);
  const total = summaryAfter?.total_slots ?? 10;
  const name = session?.firstName;
  const next = planAfter?.find((s) => s.status === 'current' && s.slot_order > slot.slot_order) ?? null;
  const badges = response.badges.status === 'ok' ? response.badges.earned : [];

  return (
    <Screen footer={<Button label="Back to my path" kind="ink" onPress={onHome} style={{ flex: 1 }} />}>
      <TopBar right={<IconButton icon="x" label="Close" onPress={onHome} />} />
      <View style={{ alignItems: 'center', marginTop: -8 }}>
        <PotIllustration />
        <T variant="overline" style={{ marginTop: 6 }}>
          Recipe {slot.slot_order} of {total}, done
        </T>
        <T variant="h1" style={[gutter, styles.center, { marginTop: 6 }]} accessibilityRole="header">
          {name ? `You made ${slot.dish_name}, ${name}.` : `You made ${slot.dish_name}.`}
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

      {badges.map((b, i) => (
        <View key={b.code} style={[styles.earned, i > 0 && { borderTopColor: color.rule, marginTop: 0 }]}>
          <Seal kind={b.kind} label={b.kind === 'completion' ? String(slot.slot_order).padStart(2, '0') : b.kind === 'mastery' ? 'M' : '★'} />
          <View style={{ flex: 1 }}>
            <T variant="overline" color="herb">
              Badge earned
            </T>
            <T variant="h3" style={{ marginTop: 4 }}>
              {b.name}
            </T>
            <T variant="caption" style={{ marginTop: 2 }}>
              {b.description}
            </T>
          </View>
        </View>
      ))}
      {response.badges.status === 'failed' ? (
        <T variant="caption" style={[gutter, { marginTop: 16 }]}>
          Badges couldn’t be checked just now. Any you earned will still appear on your profile.
        </T>
      ) : null}

      <View style={[gutter, { marginTop: 18 }]}>
        {badges.length === 0 ? <Rule strong style={{ marginBottom: 18 }} /> : null}
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
          <T variant="h3">That one was tough. Cook it again before moving on?</T>
          <T variant="caption" style={{ marginTop: 4 }}>
            Your path stays the same either way.
          </T>
          <View style={styles.repeatButtons}>
            <Button label="Cook again" kind="outline" onPress={onCookAgain} style={{ flex: 1 }} />
            <Button label="Skip" kind="quiet" onPress={onHome} style={{ flex: 1, height: 54 }} />
          </View>
        </View>
      ) : null}

      {next ? (
        <View style={[gutter, { marginTop: 20 }]}>
          <Rule style={{ marginBottom: 14 }} />
          <View style={styles.nextRow}>
            <View>
              <T variant="caption">Unlocked</T>
              <T variant="h3">
                {next.slot_order} · {next.dish_name}
              </T>
            </View>
            <T variant="caption">{next.xp_value} XP</T>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

/** "+143" counting up over ~500 ms; jumps straight there with reduce-motion on. */
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
  earned: { marginTop: 22, marginHorizontal: space.gutter, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16, borderTopWidth: 1, borderTopColor: color.ink, borderBottomWidth: 1, borderBottomColor: color.rule },
  reply: { fontFamily: font.displayRegular, fontSize: 17, lineHeight: 25, marginTop: 6, color: color.ink },
  focus: { marginTop: 10, fontFamily: font.bodySemi, color: color.ink2 },
  focusArea: { fontFamily: font.bodyBold, fontSize: 13, color: color.tomatoDeep },
  repeat: { marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: color.ink },
  repeatButtons: { flexDirection: 'row', gap: 12, marginTop: 14 },
  nextRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
