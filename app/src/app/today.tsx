/**
 * Today / plan (F2, F7). Leads with the next dish, then the 10-slot path.
 * Data: get_my_plan + get_my_plan_summary, re-read every time the screen
 * gains focus (so a check-in shows up when you come back).
 */
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PlanSlot, PlanSummary } from '../api';
import { Button } from '../components/button';
import { Icon } from '../components/icon';
import { gutter } from '../components/layout';
import { PathList } from '../components/path';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { T } from '../components/text';
import { formatToday, greetingFor } from '../domain/greeting';
import { photoForSlot } from '../domain/slot-photos';
import { useFlowCache } from '../state/flow-cache';
import { useSession } from '../state/session';
import { useAsync } from '../state/use-async';
import { useErrorAction } from '../state/use-error-action';
import { color, font, radius, space } from '../theme/tokens';

export default function Today() {
  const router = useRouter();
  const { backend, session, signOut } = useSession();
  const cache = useFlowCache();

  const data = useAsync(async () => {
    const [plan, summary] = await Promise.all([backend.getPlan(), backend.getPlanSummary()]);
    cache.setPlan(plan);
    cache.setSummary(summary);
    return { plan, summary };
  }, [backend]);

  // Re-read on focus (skip the very first focus, which useAsync already covers).
  const { reload } = data;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  const onError = useErrorAction(reload);
  const open = (slot: PlanSlot) => router.push({ pathname: '/recipe/[slotId]', params: { slotId: String(slot.slot_id) } });

  const now = new Date();

  return (
    <SafeAreaView edges={['top']} style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingBottom: space.s10, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={data.status === 'loading' && data.data !== null} onRefresh={reload} tintColor={color.tomato} />}
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline" color="ink3">
            {formatToday(now)}
          </T>
          <T variant="display" style={{ marginTop: 6 }} accessibilityRole="header">
            {greetingFor(now, session?.firstName ?? null)}
          </T>
        </View>

        {data.data ? (
          <PlanBody plan={data.data.plan} summary={data.data.summary} onOpen={open} onCookAnything={() => router.push('/cook-anything')} />
        ) : data.status === 'error' ? (
          <ErrorState error={data.error} onAction={onError} />
        ) : (
          <LoadingState title="Laying out your path…" />
        )}

        <View style={[gutter, styles.foot]}>
          <Button kind="quiet" label="Sign out" onPress={() => void signOut()} />
          {backend.label !== 'live' ? (
            <T variant="caption" style={{ textAlign: 'center' }}>
              {backend.label === 'mock' ? 'Mock mode: all data on this screen is fake.' : 'Mock AI mode: recipes and check-ins are fake.'}
            </T>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanBody({ plan, summary, onOpen, onCookAnything }: { plan: PlanSlot[]; summary: PlanSummary; onOpen: (s: PlanSlot) => void; onCookAnything: () => void }) {
  if (plan.length === 0) {
    return <EmptyState title="No path yet" body="The path’s dishes haven’t been set up on the server. Ask the team to run the migrations." />;
  }
  const current = plan.find((s) => s.status === 'current') ?? null;
  return (
    <>
      <View style={[styles.rule, gutter]}>
        <View style={styles.ruleLine} />
        <T variant="caption" style={{ marginTop: 12 }}>
          {scheduleLine(summary)}
        </T>
      </View>

      {current ? <NextUp slot={current} total={summary.total_slots} onOpen={() => onOpen(current)} /> : <PathDone summary={summary} />}

      <CookAnythingCard onOpen={onCookAnything} />

      <View style={[gutter, styles.pathHead]}>
        <T variant="h2" accessibilityRole="header">
          Weeknight basics
        </T>
        <T variant="caption">
          <T variant="caption" style={styles.xpStrong}>
            {summary.total_xp} XP
          </T>{' '}
          · {summary.completed_slots} of {summary.total_slots}
        </T>
      </View>
      <PathList slots={plan} onOpen={onOpen} />
      {summary.estimated_weeks_remaining !== null && !summary.path_complete ? (
        <T variant="caption" style={[gutter, { textAlign: 'center', marginTop: 4 }]}>
          About {summary.estimated_weeks_remaining} {summary.estimated_weeks_remaining === 1 ? 'week' : 'weeks'} to the mastery challenge at your pace.
        </T>
      ) : null}
    </>
  );
}

function CookAnythingCard({ onOpen }: { onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel="Cook anything. Type a dish and we’ll write a recipe for your kitchen."
      style={({ pressed }) => [styles.cookAnything, pressed && { opacity: 0.85 }]}
    >
      <View style={{ flex: 1 }}>
        <T variant="overline" color="ink3">
          Outside the path
        </T>
        <T variant="h3" style={{ marginTop: 6 }}>
          Cook anything
        </T>
        <T variant="caption" style={{ marginTop: 4 }}>
          Type a dish and we’ll write a recipe for your kitchen.
        </T>
      </View>
      <View style={styles.goSmall}>
        <Icon name="arrow" color="#FFFFFF" size={20} />
      </View>
    </Pressable>
  );
}

function scheduleLine(s: PlanSummary): string {
  if (s.path_complete) return `All ${s.total_slots} dishes done. Repeat any of them to keep practicing.`;
  if (s.suggested_sessions_per_week === null) return 'Set your schedule to get a suggested pace.';
  const n = s.suggested_sessions_per_week;
  return `Suggested pace: ${n} ${n === 1 ? 'session' : 'sessions'} a week, from your ${s.days_per_week} days × ${s.minutes_per_session} min.`;
}

function NextUp({ slot, total, onOpen }: { slot: PlanSlot; total: number; onOpen: () => void }) {
  const photo = photoForSlot(slot.slot_order);
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Up next: recipe ${slot.slot_order} of ${total}, ${slot.dish_name}. ${slot.technique_focus}, ${slot.xp_value} XP.`}
      style={({ pressed }) => [styles.next, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.photo}>
        {photo ? <Image source={photo.source} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        <View style={styles.photoLabel}>
          <T variant="overline" color="ink">
            {slot.is_final ? 'Final recipe · Mastery challenge' : `Recipe ${slot.slot_order} of ${total}`}
          </T>
        </View>
      </View>
      <View style={styles.meta}>
        <View style={{ flex: 1 }}>
          <T variant="h1" style={styles.nextTitle}>
            {slot.dish_name}
          </T>
          <T variant="byline" style={{ marginTop: 8 }}>
            {slot.technique_focus} · {slot.xp_value} XP
          </T>
        </View>
        <View style={styles.go}>
          <Icon name="arrow" color="#FFFFFF" size={24} />
        </View>
      </View>
    </Pressable>
  );
}

function PathDone({ summary }: { summary: PlanSummary }) {
  return (
    <View style={[gutter, { marginTop: 22 }]}>
      <T variant="overline" color="herb">
        Path complete
      </T>
      <T variant="h1" style={{ marginTop: 8 }}>
        You cooked all {summary.total_slots}.
      </T>
      <T variant="small" style={{ marginTop: 8 }}>
        {summary.total_xp} XP earned. Any dish below can be cooked again.
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  head: { paddingTop: 6 },
  rule: { marginTop: 18 },
  ruleLine: { height: 1, backgroundColor: color.ink },
  next: { marginTop: 22, marginHorizontal: space.gutter },
  photo: { height: 168, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.paperDeep, justifyContent: 'flex-end' },
  photoLabel: { alignSelf: 'flex-start', margin: 12, backgroundColor: color.paper, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 4 },
  meta: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 14, gap: 12 },
  nextTitle: { fontSize: 28, lineHeight: 32 },
  go: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.tomato, alignItems: 'center', justifyContent: 'center' },
  cookAnything: { marginTop: 22, marginHorizontal: space.gutter, paddingVertical: 16, paddingHorizontal: 16, borderWidth: 1, borderColor: color.ink, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: color.sheet },
  goSmall: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.tomato, alignItems: 'center', justifyContent: 'center' },
  pathHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 34, marginBottom: 4 },
  xpStrong: { fontFamily: font.bodyBold, color: color.ink },
  foot: { marginTop: space.s8, gap: 4 },
});
