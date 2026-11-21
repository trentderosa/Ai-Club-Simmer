/**
 * Recipe book (F10). Lists completed / mastered recipes from get_my_recipe_book.
 * The latest dish is a photo feature, earlier ones are rows, and the rest of
 * the path sits under "Still to come". Cook anything dishes sit in the same
 * list with a small tag. Tapping an entry opens its read-only detail screen.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PlanSlot, RecipeBookEntry } from '../../api';
import { DishPhotoFill } from '../../components/dish-photo';
import { Icon } from '../../components/icon';
import { gutter, pageColumn } from '../../components/layout';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import {
  COOK_ANYTHING_TAG,
  EMPTY_BOOK_COPY,
  REPEAT_XP_NOTE,
  bookEntryKey,
  bookEntryRoute,
  filterBookEntries,
  formatAddedOn,
  formatBookLabel,
  isCookAnything,
  recipeBookHeadline,
  sortBookEntries,
  upcomingDishes,
} from '../../domain/recipe-book';
import { normalizeDishName } from '../../domain/dish-name';
import { heroPhotoForGenerated } from '../../domain/generated-recipe-photo';
import { useDishPhotos } from '../../state/use-dish-photos';
import { useSession } from '../../state/session';
import { useAsync } from '../../state/use-async';
import { useErrorAction } from '../../state/use-error-action';
import { color, font, radius, space } from '../../theme/tokens';

export default function RecipeBook() {
  const router = useRouter();
  const { backend } = useSession();
  const [query, setQuery] = useState('');

  const data = useAsync(async () => {
    const [book, plan] = await Promise.all([backend.getRecipeBook(), backend.getPlan()]);
    return { book, plan };
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
  const open = (entry: RecipeBookEntry) => {
    const route = bookEntryRoute(entry);
    if (route) router.push({ pathname: '/book-entry/[kind]/[id]', params: route });
  };

  const techniqueBySlot = useMemo(() => {
    const map: Record<number, string> = {};
    for (const s of data.data?.plan ?? []) map[s.slot_id] = s.technique_focus;
    return map;
  }, [data.data?.plan]);

  const sorted = useMemo(() => sortBookEntries(data.data?.book ?? []), [data.data?.book]);
  const visible = useMemo(() => filterBookEntries(sorted, query, techniqueBySlot), [sorted, query, techniqueBySlot]);
  const upcoming = useMemo(() => (data.data ? upcomingDishes(data.data.plan, data.data.book) : []), [data.data]);

  return (
    <SafeAreaView edges={['top']} style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[pageColumn, styles.scroll]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={data.status === 'loading' && data.data !== null} onRefresh={reload} tintColor={color.tomato} />}
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline" color="ink3">
            Your recipe book
          </T>
          <T variant="display" style={styles.greeting} accessibilityRole="header">
            {data.data ? recipeBookHeadline(data.data.book.length) : 'Your dishes.'}
          </T>
          {data.data && data.data.book.length > 0 ? (
            <T variant="small" style={styles.note}>
              {REPEAT_XP_NOTE}
            </T>
          ) : null}
        </View>

        {data.data && data.data.book.length > 0 ? (
          <View style={styles.search} accessibilityRole="search">
            <Icon name="search" size={18} color={color.ink3} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search your recipes"
              placeholderTextColor={color.ink3}
              accessibilityLabel="Search your recipes"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
        ) : null}

        {data.data ? (
          <BookBody
            book={data.data.book}
            visible={visible}
            upcoming={upcoming}
            techniqueBySlot={techniqueBySlot}
            querying={query.trim().length > 0}
            onOpen={open}
            onClear={() => setQuery('')}
          />
        ) : data.status === 'error' ? (
          <ErrorState error={data.error} onAction={onError} />
        ) : (
          <LoadingState title="Opening your book…" />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function BookBody({
  book,
  visible,
  upcoming,
  techniqueBySlot,
  querying,
  onOpen,
  onClear,
}: {
  book: RecipeBookEntry[];
  visible: RecipeBookEntry[];
  upcoming: PlanSlot[];
  techniqueBySlot: Record<number, string>;
  querying: boolean;
  onOpen: (entry: RecipeBookEntry) => void;
  onClear: () => void;
}) {
  const photos = useDishPhotos(visible.map((entry) => entry.dish_name));
  if (book.length === 0) {
    return <EmptyState title="Your book is empty" body={EMPTY_BOOK_COPY} />;
  }
  if (visible.length === 0) {
    return <EmptyState title="No matching dishes" body="Try a different name, or clear the search to see the whole book." action={{ label: 'Clear search', onPress: onClear }} />;
  }

  const [feature, ...rows] = visible;
  return (
    <>
      <FeaturedEntry entry={feature} photo={photos[normalizeDishName(feature.dish_name)] ?? null} technique={techniqueFor(feature, techniqueBySlot)} onOpen={() => onOpen(feature)} />
      {rows.length > 0 ? <View style={[gutter, styles.listRule]} /> : null}
      {rows.map((entry) => (
        <BookRow key={bookEntryKey(entry)} entry={entry} photo={photos[normalizeDishName(entry.dish_name)] ?? null} technique={techniqueFor(entry, techniqueBySlot)} onOpen={() => onOpen(entry)} />
      ))}
      {!querying && upcoming.length > 0 ? (
        <>
          <View style={[gutter, styles.upcomingHead]}>
            <T variant="overline" color="ink">
              Still to come
            </T>
          </View>
          {upcoming.map((slot) => (
            <View key={slot.slot_id} style={styles.future} accessibilityLabel={`Still to come: recipe ${slot.slot_order}, ${slot.dish_name}${slot.is_final ? ', mastery challenge' : ''}`}>
              <T style={styles.futureNum}>{slot.slot_order}</T>
              <T style={styles.futureName}>{slot.dish_name}</T>
              {slot.is_final ? <T variant="caption">Mastery</T> : null}
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

function FeaturedEntry({ entry, photo, technique, onOpen }: { entry: RecipeBookEntry; photo: Parameters<typeof DishPhotoFill>[0]['photo']; technique?: string; onOpen: () => void }) {
  const added = formatAddedOn(entry.added_at);
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${entry.recipe_title}. ${formatBookLabel(entry.label, entry.times_cooked)}. Repeat for 50% XP.`}
      style={({ pressed }) => [styles.feature, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.featurePhoto}>
        <DishPhotoFill photo={photo} />
      </View>
      <View style={styles.featureBody}>
        <View style={styles.featureMeta}>
          <BookLabel entry={entry} />
          {added ? <T variant="caption">{added}</T> : null}
        </View>
        <T variant="h2" style={styles.featureTitle}>
          {entry.recipe_title}
        </T>
        <T variant="byline" style={styles.featureByline}>
          {byline(entry, technique)}
        </T>
      </View>
    </Pressable>
  );
}

function BookRow({ entry, photo, technique, onOpen }: { entry: RecipeBookEntry; photo: Parameters<typeof DishPhotoFill>[0]['photo']; technique?: string; onOpen: () => void }) {
  // The 72px thumb can't hold a credit. CC BY photos still need the line where the image is shown, so it sits under the byline. If that image fails, the thumb and this line both switch to the cutting-board credit.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = photo?.url ?? null;
  const imageFailed = url !== null && failedUrl === url;
  const credit = heroPhotoForGenerated(imageFailed ? null : photo).credit;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${entry.recipe_title}. ${formatBookLabel(entry.label, entry.times_cooked)}. Repeat for 50% XP. ${credit}.`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.rowText}>
        <BookLabel entry={entry} />
        <T variant="h3" style={styles.rowTitle}>
          {entry.recipe_title}
        </T>
        <T variant="caption" style={styles.rowByline}>
          {byline(entry, technique)}
        </T>
        <T variant="caption" color="ink3" style={styles.rowCredit} numberOfLines={1}>
          {credit}
        </T>
      </View>
      <View style={styles.thumb}>
        <DishPhotoFill photo={photo} showCredit={false} onFallback={() => setFailedUrl(url)} />
      </View>
    </Pressable>
  );
}

function BookLabel({ entry }: { entry: RecipeBookEntry }) {
  const tint = entry.label === 'mastered' ? color.tomato : color.herb;
  return (
    <View style={styles.labelRow}>
      <Icon name="check" size={14} color={tint} />
      <T variant="byline" style={{ color: tint }}>
        {formatBookLabel(entry.label, entry.times_cooked)}
      </T>
      {isCookAnything(entry) ? (
        <T variant="caption" color="ink3" style={styles.tag}>
          {COOK_ANYTHING_TAG}
        </T>
      ) : null}
    </View>
  );
}

function techniqueFor(entry: RecipeBookEntry, techniqueBySlot: Record<number, string>): string | undefined {
  return entry.slot_id === null ? undefined : techniqueBySlot[entry.slot_id];
}

function byline(entry: RecipeBookEntry, technique?: string): string {
  return technique ? `${entry.dish_name} · ${technique}` : entry.dish_name;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  scroll: { paddingBottom: space.s10, flexGrow: 1 },
  head: { paddingTop: space.s3 },
  greeting: { marginTop: space.s2 },
  note: { marginTop: space.s3 },
  search: {
    marginTop: space.s4,
    marginHorizontal: space.gutter,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.paperDeep,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.s4,
    gap: space.s2,
  },
  searchInput: { flex: 1, fontFamily: font.body, fontSize: 16, lineHeight: 22, color: color.ink, paddingVertical: 0 },
  feature: {
    marginTop: space.s5,
    marginHorizontal: space.gutter,
    backgroundColor: color.sheet,
    borderWidth: 1,
    borderColor: color.rule,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  featurePhoto: { height: 200, backgroundColor: color.paperDeep },
  featureBody: { paddingHorizontal: space.s4, paddingTop: space.s3, paddingBottom: space.s4 },
  featureMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.s2 },
  featureTitle: { marginTop: space.s2 },
  featureByline: { marginTop: space.s2 },
  listRule: { height: 1, backgroundColor: color.ink, marginTop: space.s5, marginHorizontal: space.gutter },
  row: { marginHorizontal: space.gutter, flexDirection: 'row', alignItems: 'center', gap: space.s3, paddingVertical: space.s3, minHeight: 96, borderBottomWidth: 1, borderBottomColor: color.rule },
  rowText: { flex: 1 },
  rowTitle: { marginTop: space.s1 },
  rowByline: { marginTop: space.s1 },
  rowCredit: { marginTop: 2 },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: color.paperDeep },
  labelRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.s1 },
  tag: { marginLeft: space.s1, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm, borderWidth: 1, borderColor: color.rule },
  upcomingHead: { marginTop: space.s8, paddingBottom: space.s2, borderBottomWidth: 1, borderBottomColor: color.ink },
  future: { marginHorizontal: space.gutter, flexDirection: 'row', alignItems: 'center', gap: space.s2, minHeight: 48, paddingVertical: space.s3, borderBottomWidth: 1, borderBottomColor: color.rule },
  futureNum: { width: 28, fontFamily: font.display, fontSize: 16, lineHeight: 22, color: color.ink3, fontVariant: ['tabular-nums'] },
  futureName: { flex: 1, fontFamily: font.body, fontSize: 16, lineHeight: 22, color: color.ink3 },
});
