/**
 * Profile / You (F1 edit, F7 XP, F9 badges). First name comes from auth
 * user_metadata; XP and path progress from get_my_plan_summary; badges from
 * get_my_badges; onboarding answers from the profiles row. No leagues,
 * streaks, or name column.
 */
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Badge, PlanSummary, Profile } from '../../api';
import { Button } from '../../components/button';
import { gutter, pageColumn, SectionHead } from '../../components/layout';
import { Seal } from '../../components/seal';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import { badgeCounts, badgeSealLabel } from '../../domain/badges';
import {
  budgetTitle,
  CUISINE_OPTIONS,
  DIETARY_OPTIONS,
  formatChoiceList,
  MEAL_TYPE_OPTIONS,
  experienceTitle,
  formatEquipmentList,
  formatSchedule,
  initialFromName,
  parseGoals,
  profileSubtitle,
} from '../../domain/profile-copy';
import { useSession } from '../../state/session';
import { useAsync } from '../../state/use-async';
import { useErrorAction } from '../../state/use-error-action';
import { color, font, space } from '../../theme/tokens';

export default function ProfileScreen() {
  const router = useRouter();
  const { backend, session, requireSession, signOut } = useSession();

  const data = useAsync(async () => {
    const { userId } = requireSession();
    const [profile, summary, badges] = await Promise.all([backend.getProfile(userId), backend.getPlanSummary(), backend.getBadges()]);
    return { profile, summary, badges };
  }, [backend]);

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
  const firstName = session?.firstName ?? null;

  return (
    <SafeAreaView edges={['top']} style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[pageColumn, styles.scroll]}
        refreshControl={<RefreshControl refreshing={data.status === 'loading' && data.data !== null} onRefresh={reload} tintColor={color.tomato} />}
      >
        {data.data ? (
          <ProfileBody
            firstName={firstName}
            profile={data.data.profile}
            summary={data.data.summary}
            badges={data.data.badges}
            onEdit={() => router.push('/edit-profile' as Href)}
            onSignOut={() => void signOut()}
            mockLabel={backend.label === 'live' ? null : backend.label === 'mock' ? 'Mock mode: all data on this screen is fake.' : 'Mock AI mode: recipes and check-ins are fake.'}
          />
        ) : data.status === 'error' ? (
          <ErrorState error={data.error} onAction={onError} secondary={{ label: 'Sign out', onPress: () => void signOut() }} />
        ) : (
          <LoadingState title="Loading your profile…" />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileBody({
  firstName,
  profile,
  summary,
  badges,
  onEdit,
  onSignOut,
  mockLabel,
}: {
  firstName: string | null;
  profile: Profile | null;
  summary: PlanSummary;
  badges: Badge[];
  onEdit: () => void;
  onSignOut: () => void;
  mockLabel: string | null;
}) {
  const subtitle = profile ? profileSubtitle(profile) : null;
  const counts = badgeCounts(badges);
  const name = firstName ?? 'You';

  return (
    <>
      <View style={styles.prof}>
        <View style={styles.avatar} accessibilityIgnoresInvertColors>
          <T style={styles.avatarLetter}>{initialFromName(firstName)}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T variant="h2" accessibilityRole="header">
            {name}
          </T>
          {subtitle ? (
            <T variant="caption" style={{ marginTop: 2 }}>
              {subtitle}
            </T>
          ) : null}
        </View>
      </View>

      <View style={styles.stats} accessibilityLabel={`${summary.total_xp} total XP, ${summary.completed_slots} of ${summary.total_slots} on the path`}>
        <View style={styles.stat}>
          <T style={styles.statValue}>{summary.total_xp}</T>
          <T variant="byline" color="ink3">
            Total XP
          </T>
        </View>
        <View style={[styles.stat, styles.statDivider]}>
          <T style={styles.statValue}>
            {summary.completed_slots}/{summary.total_slots}
          </T>
          <T variant="byline" color="ink3">
            Path
          </T>
        </View>
      </View>

      <View style={[gutter, styles.section]}>
        <SectionHead title="Badges" aside={counts.total ? `${counts.earned} of ${counts.total}` : undefined} />
      </View>
      {badges.length === 0 ? (
        <EmptyState compact title="No badges yet" body="Cook a recipe and finish the check-in to earn the first one." />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shelf}>
          {badges.map((badge) => (
            <View
              key={badge.code}
              style={styles.shelfItem}
              accessibilityLabel={`${badge.name}. ${badge.earned ? 'Earned' : 'Not earned yet'}. ${badge.description}`}
            >
              <Seal label={badgeSealLabel(badge)} kind={badge.kind} size={64} earned={badge.earned} />
              <T style={[styles.shelfName, !badge.earned && styles.shelfNameLocked]} numberOfLines={2}>
                {badge.name}
              </T>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={[gutter, styles.section]}>
        <SectionHead
          title="Your answers"
          aside={
            <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel="Edit your onboarding answers" hitSlop={8} style={styles.editHit}>
              <T variant="caption" style={styles.edit}>
                Edit
              </T>
            </Pressable>
          }
        />
        {profile ? (
          <Answers profile={profile} />
        ) : (
          <T variant="small" style={styles.missing}>
            We couldn’t load your onboarding answers. You can still edit them.
          </T>
        )}
      </View>

      <View style={[gutter, styles.signOut]}>
        <Button kind="quiet" label="Sign out" onPress={onSignOut} />
        {mockLabel ? (
          <T variant="caption" style={{ textAlign: 'center' }}>
            {mockLabel}
          </T>
        ) : null}
      </View>
    </>
  );
}

function Answers({ profile }: { profile: Profile }) {
  const goals = parseGoals(profile.goals);
  const rows: { label: string; value: string }[] = [];
  const exp = experienceTitle(profile.experience_level);
  if (exp) rows.push({ label: 'Experience', value: exp });
  if (goals.length) rows.push({ label: 'Goals', value: goals.join(', ') });
  const equipment = formatEquipmentList(profile.equipment);
  if (equipment) rows.push({ label: 'Equipment', value: equipment });
  const budget = budgetTitle(profile.budget);
  if (budget) rows.push({ label: 'Budget', value: budget });
  const cuisines = formatChoiceList(profile.cuisines, CUISINE_OPTIONS);
  if (cuisines) rows.push({ label: 'Cuisines', value: cuisines });
  const mealTypes = formatChoiceList(profile.meal_types, MEAL_TYPE_OPTIONS);
  if (mealTypes) rows.push({ label: 'Meals', value: mealTypes });
  const dietary = formatChoiceList(profile.dietary_needs, DIETARY_OPTIONS);
  if (dietary) rows.push({ label: 'Diet', value: dietary });
  const schedule = formatSchedule(profile.days_per_week, profile.minutes_per_session);
  if (schedule) rows.push({ label: 'Schedule', value: schedule });

  if (rows.length === 0) {
    return (
      <T variant="small" style={styles.missing}>
        No answers saved yet.
      </T>
    );
  }

  return (
    <View>
      {rows.map((row, i) => (
        <View key={row.label} style={[styles.answer, i === 0 && styles.answerFirst]}>
          <T variant="caption" style={styles.answerLabel}>
            {row.label}
          </T>
          <T style={styles.answerValue}>{row.value}</T>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  scroll: { paddingBottom: space.s10, flexGrow: 1 },
  prof: { flexDirection: 'row', alignItems: 'center', gap: space.s4, paddingHorizontal: space.gutter, paddingTop: space.s4 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: color.herbWash, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontFamily: font.display, fontSize: 26, lineHeight: 32, color: color.herb },
  stats: { flexDirection: 'row', marginTop: space.s5, marginHorizontal: space.gutter, borderTopWidth: 1, borderTopColor: color.ink, borderBottomWidth: 1, borderBottomColor: color.rule },
  stat: { flex: 1, alignItems: 'center', paddingVertical: space.s4 },
  statDivider: { borderLeftWidth: 1, borderLeftColor: color.rule },
  statValue: { fontFamily: font.display, fontSize: 28, lineHeight: 32, color: color.ink, fontVariant: ['tabular-nums'], textAlign: 'center' },
  section: { marginTop: space.s8 },
  shelf: { paddingHorizontal: space.gutter, paddingTop: space.s4, paddingBottom: space.s2, gap: space.s4 },
  shelfItem: { width: 96, alignItems: 'center' },
  shelfName: { marginTop: space.s2, minHeight: 34, fontFamily: font.body, fontSize: 13, lineHeight: 17, color: color.ink2, textAlign: 'center' },
  shelfNameLocked: { color: color.lockedText },
  editHit: { minHeight: 44, justifyContent: 'center', paddingLeft: space.s3 },
  edit: { fontFamily: font.bodySemi, color: color.tomatoDeep },
  missing: { marginTop: space.s3 },
  answer: { paddingVertical: space.s3, borderBottomWidth: 1, borderBottomColor: color.rule, justifyContent: 'center' },
  answerFirst: { marginTop: space.s1 },
  answerLabel: { fontFamily: font.bodyBold, letterSpacing: 0.8, textTransform: 'uppercase' },
  answerValue: { marginTop: space.s1, fontFamily: font.body, fontSize: 17, lineHeight: 24, color: color.ink },
  signOut: { marginTop: space.s8, paddingTop: space.s4, borderTopWidth: 1, borderTopColor: color.rule, gap: space.s2 },
});
