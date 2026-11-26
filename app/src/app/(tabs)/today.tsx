/**
 * Today / plan (F2, F7). Leads with the next dish, then the 10-slot path.
 * Data: get_my_plan + get_my_plan_summary, re-read every time the screen
 * gains focus (so a check-in shows up when you come back).
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { DishPhoto, PlanSlot, PlanSummary } from '../../api';
import { DishPhotoFill } from '../../components/dish-photo';
import { Icon } from '../../components/icon';
import { gutter, pageColumn } from '../../components/layout';
import { PathList } from '../../components/path';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import { normalizeDishName } from '../../domain/dish-name';
import { formatToday, greetingFor } from '../../domain/greeting';
import { useDishPhotos } from '../../state/use-dish-photos';
import { useFlowCache } from '../../state/flow-cache';
import { useSession } from '../../state/session';
import { useAsync } from '../../state/use-async';
import { useErrorAction } from '../../state/use-error-action';
import { color, font, radius, space } from '../../theme/tokens';

export default function Today() {
  const router = useRouter();
  const { backend, session } = useSession();
  const cache = useFlowCache();
  const [notice, setNotice] = useState<string | null>(null);

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
      setNotice(cache.takeNotice());
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload, cache]),
  );

  const onError = useErrorAction(reload);
  const open = (slot: PlanSlot) => router.push({ pathname: '/recipe/[slotId]', params: { slotId: String(slot.slot_id) } });

  const now = new Date();

  return (
    <SafeAreaView edges={['top']} style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[pageColumn, styles.scroll]}
        refreshControl={<RefreshControl refreshing={data.status === 'loading' && data.data !== null} onRefresh={reload} tintColor={color.tomato} />}
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline" color="ink3">
            {formatToday(now)}
          </T>
          <T variant="display" style={styles.greeting} accessibilityRole="header">
            {greetingFor(now, session?.firstName ?? null)}
          </T>
        </View>

        {notice ? (
          <T variant="small" style={[gutter, { marginTop: 12 }]} accessibilityLiveRegion="polite">
            {notice}
          </T>
        ) : null}

        {data.data ? (
          <PlanBody plan={data.data.plan} summary={data.data.summary} onOpen={open} onCookAnything={() => router.push('/cook-anything')} />
        ) : data.status === 'error' ? (
          <ErrorState error={data.error} onAction={onError} />
        ) : (
          <LoadingState title="Laying out your path…" />
        )}

        {backend.label !== 'live' ? (
          <View style={[gutter, styles.foot]}>
            <T variant="caption" style={{ textAlign: 'center' }}>
              {backend.label === 'mock' ? 'Mock mode: all data on this screen is fake.' : 'Mock AI mode: recipes and check-ins are fake.'}
            </T>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanBody({ plan, summary, onOpen, onCookAnything }: { plan: PlanSlot[]; summary: PlanSummary; onOpen: (s: PlanSlot) => void; onCookAnything: () => void }) {
  const current = plan.find((s) => s.status === 'current') ?? null;
  const dishPhotos = useDishPhotos(current ? [current.dish_name] : []);
  const onPhotoOutage = useErrorAction(dishPhotos.retry);
  if (plan.length === 0) {
    return <EmptyState title="No path yet" body="The path’s dishes haven’t been set up on the server. Ask the team to run the migrations." />;
  }
  const photo = current ? (dishPhotos.photos[normalizeDishName(current.dish_name)] ?? null) : null;
  return (
    <>
      <View style={[styles.rule, gutter]}>
        <View style={styles.ruleLine} />
        <T variant="caption" style={styles.schedule}>
          {scheduleLine(summary)}
        </T>
      </View>

      {dishPhotos.outage ? <ErrorState compact error={dishPhotos.outage} onAction={onPhotoOutage} /> : null}

      {current ? <NextUp slot={current} total={summary.total_slots} photo={photo} onOpen={() => onOpen(current)} /> : <PathDone summary={summary} />}

      <CookAnythingCard onOpen={onCookAnything} />

      <View style={[gutter, styles.pathHead]}>
        <T variant="h2" accessibilityRole="header">
          Weeknight basics
        </T>
        <T variant="caption" style={styles.pathMeta}>
          <T variant="caption" style={styles.xpStrong}>
            {summary.total_xp} XP
          </T>{' '}
          · {summary.completed_slots} of {summary.total_slots}
        </T>
      </View>
      <PathList slots={plan} onOpen={onOpen} />
      {summary.estimated_weeks_remaining !== null && !summary.path_complete ? (
        <T variant="caption" style={[gutter, styles.pace]}>
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
        <T variant="h3" style={styles.cookTitle}>
          Cook anything
        </T>
        <T variant="caption" style={styles.cookBody}>
          Type a dish and we’ll write a recipe for your kitchen.
        </T>
      </View>
      <View style={styles.goSmall}>
        <Icon name="arrow" color={color.paper} size={20} />
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

function NextUp({ slot, total, photo, onOpen }: { slot: PlanSlot; total: number; photo: DishPhoto | null; onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Up next: recipe ${slot.slot_order} of ${total}, ${slot.dish_name}. ${slot.technique_focus}, ${slot.xp_value} XP.`}
      style={({ pressed }) => [styles.next, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.photo}>
        <DishPhotoFill photo={photo} creditAt="top" creditStyle={styles.todayCredit} />
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
          <T variant="byline" style={styles.nextByline}>
            {slot.technique_focus} · {slot.xp_value} XP
          </T>
        </View>
        <View style={styles.go}>
          <Icon name="arrow" color={color.onAccent} size={22} />
        </View>
      </View>
    </Pressable>
  );
}

function PathDone({ summary }: { summary: PlanSummary }) {
  return (
    <View style={[gutter, styles.done]}>
      <T variant="overline" color="herb">
        Path complete
      </T>
      <T variant="h1" style={styles.doneTitle}>
        You cooked all {summary.total_slots}.
      </T>
      <T variant="small" style={styles.doneBody}>
        {summary.total_xp} XP earned. Any dish below can be cooked again.
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  scroll: { paddingBottom: space.s10, flexGrow: 1 },
  head: { paddingTop: space.s3 },
  greeting: { marginTop: space.s2 },
  rule: { marginTop: space.s4 },
  ruleLine: { height: 1, backgroundColor: color.ink },
  schedule: { marginTop: space.s3 },
  next: {
    marginTop: space.s5,
    marginHorizontal: space.gutter,
    backgroundColor: color.sheet,
    borderWidth: 1,
    borderColor: color.rule,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  photo: { height: 188, backgroundColor: color.paperDeep, justifyContent: 'flex-end' },
  photoLabel: { alignSelf: 'flex-start', margin: space.s3, backgroundColor: color.paper, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.sm },
  todayCredit: { maxWidth: '45%' },
  meta: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s3, paddingHorizontal: space.s4, paddingVertical: space.s4 },
  nextTitle: { fontSize: 28, lineHeight: 32 },
  nextByline: { marginTop: space.s2 },
  go: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.tomato, alignItems: 'center', justifyContent: 'center' },
  cookAnything: {
    marginTop: space.s3,
    marginHorizontal: space.gutter,
    paddingVertical: space.s4,
    paddingHorizontal: space.s4,
    minHeight: 72,
    borderWidth: 1,
    borderColor: color.rule,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s3,
    backgroundColor: color.sheet,
  },
  goSmall: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center' },
  cookTitle: { marginTop: space.s2 },
  cookBody: { marginTop: space.s1 },
  pathHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: space.s8, marginBottom: space.s2, gap: space.s3 },
  pathMeta: { flexShrink: 1, textAlign: 'right' },
  xpStrong: { fontFamily: font.bodyBold, color: color.ink },
  pace: { textAlign: 'center', marginTop: space.s3 },
  done: { marginTop: space.s5 },
  doneTitle: { marginTop: space.s2 },
  doneBody: { marginTop: space.s2 },
  foot: { marginTop: space.s6, gap: space.s1 },
});
