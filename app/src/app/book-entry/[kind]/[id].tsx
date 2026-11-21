/**
 * Recipe book detail (F10). A read-only look at a finished recipe: the recipe
 * itself, the user's own check-ins on it ("Your cooks"), and "Cook again" into
 * the existing cook flow. Path entries load the recipe through the ai-server
 * (so the final slot's hidden steps stay masked, exactly as on the recipe
 * screen); Cook anything entries read their saved recipe from Supabase.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, type BookTarget, type CheckInHistoryEntry, type DishPhoto, type Recipe, type Video, type Videos } from '../../../api';
import { Button, IconButton } from '../../../components/button';
import { DishPhotoFill } from '../../../components/dish-photo';
import { pageColumn, SectionHead } from '../../../components/layout';
import { EmptyState, ErrorState, LoadingState } from '../../../components/states';
import { T } from '../../../components/text';
import { VideoRow } from '../../../components/video';
import { COOK_ANYTHING_TAG, formatCookDate, formatRating } from '../../../domain/recipe-book';
import { useSession } from '../../../state/session';
import { useAsync } from '../../../state/use-async';
import { useErrorAction } from '../../../state/use-error-action';
import { useGeneratedRecipe } from '../../../state/use-generated-recipe';
import { useSlotRecipe } from '../../../state/use-slot-recipe';
import { color, font, radius, space } from '../../../theme/tokens';

const INGREDIENTS_PREVIEW = 7;
const HIDDEN_STEP_NOTE = 'Hidden for the mastery challenge. You’ll see it while you cook.';

function param(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default function BookEntryScreen() {
  const params = useLocalSearchParams<{ kind: string; id: string }>();
  const kind = param(params.kind);
  const id = param(params.id);
  if (kind === 'path') return <PathEntry slotId={Number(id)} />;
  if (kind === 'cook-anything') return <CookAnythingEntry recipeId={id} />;
  return <NotFound />;
}

function NotFound() {
  const router = useRouter();
  return (
      <SafeAreaView style={styles.fill}>
        <View style={[styles.fill, pageColumn]}>
        <View style={styles.bar}>
          <IconButton icon="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/book'))} />
        </View>
      <EmptyState title="Recipe not found" body="That recipe isn’t in your book." action={{ label: 'Back to my book', onPress: () => router.replace('/book') }} />
        </View>
    </SafeAreaView>
  );
}

function PathEntry({ slotId }: { slotId: number }) {
  const router = useRouter();
  const data = useSlotRecipe(slotId);
  const history = useCheckInHistory(Number.isInteger(slotId) && slotId > 0 ? { kind: 'path', slotId } : null);
  const res = data.data?.recipe;
  return (
    <EntryView
      state={data}
      title="Opening your recipe…"
      history={history}
      overline={data.data ? `Recipe ${data.data.slot.slot_order} · ${data.data.slot.technique_focus}` : ''}
      recipe={res?.recipe}
      videos={res?.videos}
      dishVideos={res?.dish_videos}
      photo={res?.photo}
      onCookAgain={() => router.push({ pathname: '/cook/[slotId]', params: { slotId: String(slotId) } })}
    />
  );
}

function CookAnythingEntry({ recipeId }: { recipeId: string | undefined }) {
  const router = useRouter();
  const data = useGeneratedRecipe(recipeId);
  const history = useCheckInHistory(recipeId ? { kind: 'cook_anything', generatedRecipeId: recipeId } : null);
  const res = data.data;
  return (
    <EntryView
      state={data}
      title="Opening your recipe…"
      history={history}
      overline={COOK_ANYTHING_TAG}
      recipe={res?.recipe}
      videos={res?.videos}
      dishVideos={res?.dish_videos}
      photo={res?.photo}
      onCookAgain={() => res && router.push({ pathname: '/generated-cook/[recipeId]', params: { recipeId: res.generated_recipe_id } })}
    />
  );
}

interface CookHistory {
  rows: CheckInHistoryEntry[];
  /** From the recipe book entry (the history read is capped); null if unknown. */
  timesCooked: number | null;
}

/** The user's own check-ins on this entry. Reloads when the screen regains focus (after cooking again). */
function useCheckInHistory(target: BookTarget | null) {
  const { backend } = useSession();
  const key = target ? (target.kind === 'path' ? `path:${target.slotId}` : `cook:${target.generatedRecipeId}`) : 'none';
  const state = useAsync<CookHistory>(async () => {
    if (!target) throw new ApiError('not_found', 'Unknown recipe.');
    const [rows, timesCooked] = await Promise.all([
      backend.getCheckInHistory(target),
      // The history read is capped, so the count comes from the book entry. A failure here just hides the count.
      backend
        .getRecipeBook()
        .then((book) => book.find((e) => (target.kind === 'path' ? e.kind === 'path' && e.slot_id === target.slotId : e.generated_recipe_id === target.generatedRecipeId))?.times_cooked ?? null)
        .catch(() => null),
    ]);
    return { rows, timesCooked };
  }, [backend, key]);
  const { reload } = state;
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
  return state;
}

type Loadable = { status: 'loading' | 'error' | 'ready'; error: unknown; reload: () => void };

function EntryView({
  state,
  title,
  history,
  overline,
  recipe,
  videos,
  dishVideos,
  photo,
  onCookAgain,
}: {
  state: Loadable;
  title: string;
  history: Loadable & { data: CookHistory | null };
  overline: string;
  recipe: Recipe | undefined;
  videos: Videos | undefined;
  dishVideos: Video[] | undefined;
  photo: DishPhoto | null | undefined;
  onCookAgain: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { backend } = useSession();
  const onError = useErrorAction(state.reload);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/book'));

  if (state.status !== 'ready' || !recipe) {
    return (
      <SafeAreaView style={styles.fill}>
        <View style={[styles.fill, pageColumn]}>
        <View style={styles.bar}>
          <IconButton icon="back" label="Back" onPress={back} />
        </View>
        {state.status === 'error' ? <ErrorState error={state.error} onAction={onError} /> : <LoadingState title={title} />}
        </View>
      </SafeAreaView>
    );
  }

  const placeholder = backend.label !== 'live';
  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={[pageColumn, styles.scroll]}>
        <View style={styles.hero}>
          <DishPhotoFill key={photo?.url ?? 'none'} photo={photo} linkCredit />
          <View style={[styles.float, { top: insets.top + 4 }]}>
            <IconButton icon="back" label="Back" onPress={back} filled />
          </View>
        </View>

        <View style={styles.titleBlock}>
          <T variant="overline">{overline}</T>
          <T variant="h1" style={styles.title} accessibilityRole="header">
            {recipe.title}
          </T>
        </View>

        <View style={styles.facts}>
          <Fact value={`${recipe.timeEstimateMinutes} min`} label="Time" />
          <Fact value={String(recipe.steps.length)} label="Steps" divider />
          <Fact value={String(recipe.ingredients.length)} label="Ingredients" divider />
        </View>

        <YourCooks history={history} />

        {recipe.coachNote ? (
          <View style={styles.note}>
            <T variant="overline" style={{ color: color.butterInk }}>
              Coach’s note
            </T>
            <T style={styles.noteText}>{recipe.coachNote}</T>
          </View>
        ) : null}

        <Ingredients recipe={recipe} />
        <Steps recipe={recipe} />
        <VideoSection recipe={recipe} videos={videos ?? {}} placeholder={placeholder} />
        <DishVideoSection videos={dishVideos ?? []} placeholder={placeholder} />
      </ScrollView>

      <View style={[styles.footerBar, { paddingBottom: Math.max(insets.bottom, space.s3) + space.s3 }]}>
        <View style={[pageColumn, styles.footer]}>
          <Button label="Cook again" onPress={onCookAgain} style={styles.footerBtn} />
        </View>
      </View>
    </View>
  );
}

function YourCooks({ history }: { history: Loadable & { data: CookHistory | null } }) {
  const rows = history.data?.rows ?? null;
  const count = history.data ? (history.data.timesCooked ?? history.data.rows.length) : null;
  return (
    <View style={styles.sec}>
      <SectionHead title="Your cooks" aside={count !== null ? `${count} ${count === 1 ? 'cook' : 'cooks'}` : undefined} />
      {rows && rows.length > 0 ? (
        rows.map((row) => <CookRow key={row.id} row={row} />)
      ) : history.status === 'error' ? (
        <View style={styles.cookRow}>
          <T variant="small">Couldn’t load your cooks.</T>
          <Pressable accessibilityRole="button" onPress={history.reload} style={{ marginTop: 6 }}>
            <T variant="bodySemi">Try again</T>
          </Pressable>
        </View>
      ) : history.status === 'loading' && !rows ? (
        <View style={styles.cookRow}>
          <T variant="small" color="ink3">
            Loading your cooks…
          </T>
        </View>
      ) : (
        <View style={styles.cookRow}>
          <T variant="small" color="ink3">
            No check-ins yet.
          </T>
        </View>
      )}
    </View>
  );
}

function CookRow({ row }: { row: CheckInHistoryEntry }) {
  const date = formatCookDate(row.created_at);
  const wentWell = row.went_well?.trim();
  const wasHard = row.was_hard?.trim();
  return (
    <View style={styles.cookRow} accessibilityLabel={`${date ?? 'Cooked'}, rated ${formatRating(row.difficulty_rating)}`}>
      <View style={styles.cookHead}>
        <T variant="bodySemi">{date ?? 'Cooked'}</T>
        <T variant="byline" color="ink3">
          {formatRating(row.difficulty_rating)}
        </T>
      </View>
      {wentWell ? (
        <T variant="small" style={styles.cookNote}>
          Went well: {wentWell}
        </T>
      ) : null}
      {wasHard ? (
        <T variant="small" style={styles.cookNote}>
          Was hard: {wasHard}
        </T>
      ) : null}
    </View>
  );
}

function Fact({ value, label, divider }: { value: string; label: string; divider?: boolean }) {
  return (
    <View style={[styles.fact, divider && styles.factDivider]}>
      <T style={styles.factValue}>{value}</T>
      <T variant="byline" color="ink3">
        {label}
      </T>
    </View>
  );
}

function Ingredients({ recipe }: { recipe: Recipe }) {
  const [all, setAll] = useState(false);
  const items = all ? recipe.ingredients : recipe.ingredients.slice(0, INGREDIENTS_PREVIEW);
  const hidden = recipe.ingredients.length - items.length;
  return (
    <View style={styles.sec}>
      <SectionHead title="Ingredients" aside={`${recipe.ingredients.length} ${recipe.ingredients.length === 1 ? 'item' : 'items'}`} />
      {items.map((ing, i) => (
        <View key={`${ing.name}-${i}`} style={styles.ing}>
          <T variant="bodySemi" style={styles.amount}>
            {ing.amount}
          </T>
          <T style={{ flex: 1 }}>{ing.name}</T>
        </View>
      ))}
      {hidden > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={styles.ing}>
          <View style={styles.amount} />
          <T variant="bodySemi" color="ink2">+ {hidden} more</T>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Read-only steps. A step the server masked (`isHidden`, final slot) never
 * shows its text here; the real content only comes from a reveal in cook mode.
 */
function Steps({ recipe }: { recipe: Recipe }) {
  return (
    <View style={styles.sec}>
      <SectionHead title="Steps" aside={`${recipe.steps.length} ${recipe.steps.length === 1 ? 'step' : 'steps'}`} />
      {recipe.steps.map((step, i) => (
        <View key={i} style={styles.ing}>
          <T variant="bodySemi" style={styles.stepNum}>
            {i + 1}
          </T>
          <T style={{ flex: 1 }} color={step.isHidden ? 'ink3' : undefined}>
            {step.isHidden ? HIDDEN_STEP_NOTE : step.instruction}
          </T>
        </View>
      ))}
    </View>
  );
}

function DishVideoSection({ videos, placeholder }: { videos: Video[]; placeholder: boolean }) {
  if (!videos.length) return null;
  return (
    <View style={styles.sec}>
      <SectionHead title="Watch someone make it" aside={videos.length === 1 ? '1 video' : `${videos.length} videos`} />
      {videos.map((video) => (
        <VideoRow key={video.videoId} video={video} placeholder={placeholder} caption={`YouTube${placeholder ? ' · placeholder' : ''}`} />
      ))}
    </View>
  );
}

function VideoSection({ recipe, videos, placeholder }: { recipe: Recipe; videos: Videos; placeholder: boolean }) {
  const rows = recipe.steps.flatMap((s, i) => {
    const v = s.techniqueName ? videos[s.techniqueName] : undefined;
    return v ? [{ v, step: i + 1 }] : [];
  });
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.v.videoId) ? false : (seen.add(r.v.videoId), true)));
  if (!unique.length) return null;
  return (
    <View style={styles.sec}>
      <SectionHead title="Learn the move" aside={unique.length === 1 ? `Step ${unique[0].step}` : `${unique.length} videos`} />
      {unique.map(({ v, step }) => (
        <VideoRow key={v.videoId} video={v} placeholder={placeholder} caption={`Step ${step} · YouTube${placeholder ? ' · placeholder' : ''}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  scroll: { paddingBottom: 128 },
  bar: { height: 56, justifyContent: 'center', paddingHorizontal: space.s3 },
  hero: { height: 280, backgroundColor: color.paperDeep, overflow: 'hidden' },
  float: { position: 'absolute', left: space.s3 },
  titleBlock: { paddingTop: space.s5, paddingHorizontal: space.gutter },
  title: { marginTop: space.s2, fontSize: 34, lineHeight: 40 },
  facts: { flexDirection: 'row', marginTop: space.s5, marginHorizontal: space.gutter, borderTopWidth: 1, borderTopColor: color.ink, borderBottomWidth: 1, borderBottomColor: color.rule },
  fact: { flex: 1, alignItems: 'center', paddingVertical: space.s3, paddingHorizontal: space.s1 },
  factDivider: { borderLeftWidth: 1, borderLeftColor: color.rule },
  factValue: { fontFamily: font.display, fontSize: 22, lineHeight: 28, textAlign: 'center', fontVariant: ['tabular-nums'] },
  note: { marginTop: space.s5, marginHorizontal: space.gutter, paddingVertical: space.s4, paddingHorizontal: space.s4, backgroundColor: color.butterWash, borderRadius: radius.sm },
  noteText: { fontFamily: font.displayRegular, fontSize: 16, lineHeight: 23, marginTop: space.s1 },
  sec: { marginTop: space.s8, marginHorizontal: space.gutter },
  ing: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space.s3, minHeight: 48, borderBottomWidth: 1, borderBottomColor: color.ruleSoft },
  amount: { width: 112, paddingRight: space.s3 },
  stepNum: { width: 36, paddingRight: space.s2 },
  cookRow: { paddingVertical: space.s3, borderBottomWidth: 1, borderBottomColor: color.ruleSoft },
  cookHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.s3 },
  cookNote: { marginTop: space.s1 },
  footerBar: { backgroundColor: color.paper, borderTopWidth: 1, borderTopColor: color.rule },
  footer: { flexDirection: 'row', paddingHorizontal: space.gutter, paddingTop: space.s3 },
  footerBtn: { flex: 1 },
});
