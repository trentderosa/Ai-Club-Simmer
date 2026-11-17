/**
 * Recipe book (F10). Lists completed / mastered recipes from get_my_recipe_book.
 * The latest dish is a photo feature, earlier ones are rows, and the rest of
 * the path sits under "Still to come". Tapping an entry opens the recipe screen.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PlanSlot, RecipeBookEntry } from '../../api';
import { DishPhotoFill } from '../../components/dish-photo';
import { Icon } from '../../components/icon';
import { gutter } from '../../components/layout';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import {
  EMPTY_BOOK_COPY,
  REPEAT_XP_NOTE,
  filterBookEntries,
  formatAddedOn,
  formatBookLabel,
  recipeBookHeadline,
  sortBookEntries,
  upcomingDishes,
} from '../../domain/recipe-book';
import { normalizeDishName } from '../../domain/dish-name';
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
  const open = (slotId: number) => router.push({ pathname: '/recipe/[slotId]', params: { slotId: String(slotId) } });

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
        contentContainerStyle={{ paddingBottom: space.s10, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={data.status === 'loading' && data.data !== null} onRefresh={reload} tintColor={color.tomato} />}
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline" color="ink3">
            Your recipe book
          </T>
          <T variant="display" style={{ marginTop: 6 }} accessibilityRole="header">
            {data.data ? recipeBookHeadline(data.data.book.length) : 'Your dishes.'}
          </T>
          {data.data && data.data.book.length > 0 ? (
            <T variant="small" style={{ marginTop: 10 }}>
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
  onOpen: (slotId: number) => void;
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
      <FeaturedEntry entry={feature} photo={photos[normalizeDishName(feature.dish_name)] ?? null} technique={techniqueBySlot[feature.slot_id]} onOpen={() => onOpen(feature.slot_id)} />
      {rows.length > 0 ? <View style={[gutter, styles.listRule]} /> : null}
      {rows.map((entry) => (
        <BookRow key={entry.slot_id} entry={entry} photo={photos[normalizeDishName(entry.dish_name)] ?? null} technique={techniqueBySlot[entry.slot_id]} onOpen={() => onOpen(entry.slot_id)} />
      ))}
      {!querying && upcoming.length > 0 ? (
        <>
          <View style={[gutter, { marginTop: 28 }]}>
            <T variant="overline" color="ink">
              Still to come
            </T>
          </View>
          {upcoming.map((slot) => (
            <View key={slot.slot_id} style={styles.future} accessibilityLabel={`Still to come: recipe ${slot.slot_order}, ${slot.dish_name}${slot.is_final ? ', mastery challenge' : ''}`}>
              <T style={styles.futureNum}>{slot.slot_order}</T>
              <T style={styles.futureName}>{slot.dish_name}</T>
              <T variant="caption">{slot.is_final ? 'Mastery' : ''}</T>
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
      <View style={styles.featureMeta}>
        <BookLabel label={entry.label} times={entry.times_cooked} />
        {added ? <T variant="caption">{added}</T> : null}
      </View>
      <T variant="h2" style={{ marginTop: 4 }}>
        {entry.recipe_title}
      </T>
      <T variant="byline" style={{ marginTop: 6 }}>
        {byline(entry, technique)}
      </T>
    </Pressable>
  );
}

function BookRow({ entry, photo, technique, onOpen }: { entry: RecipeBookEntry; photo: Parameters<typeof DishPhotoFill>[0]['photo']; technique?: string; onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${entry.recipe_title}. ${formatBookLabel(entry.label, entry.times_cooked)}. Repeat for 50% XP.`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
    >
      <View style={{ flex: 1, paddingRight: 12 }}>
        <BookLabel label={entry.label} times={entry.times_cooked} />
        <T variant="h3" style={{ marginTop: 4 }}>
          {entry.recipe_title}
        </T>
        <T variant="caption" style={{ marginTop: 3 }}>
          {byline(entry, technique)}
        </T>
      </View>
      <View style={styles.thumb}>
        <DishPhotoFill photo={photo} creditStyle={styles.thumbCredit} />
      </View>
    </Pressable>
  );
}

function BookLabel({ label, times }: { label: RecipeBookEntry['label']; times: number }) {
  return (
    <View style={styles.labelRow}>
      <Icon name="check" size={14} color={label === 'mastered' ? color.tomato : color.herb} />
      <T variant="byline" style={{ color: label === 'mastered' ? color.tomato : color.herb }}>
        {formatBookLabel(label, times)}
      </T>
    </View>
  );
}

function byline(entry: RecipeBookEntry, technique?: string): string {
  return technique ? `${entry.dish_name} · ${technique}` : entry.dish_name;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  head: { paddingTop: 6 },
  search: {
    marginTop: 16,
    marginHorizontal: space.gutter,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.paperDeep,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 8,
  },
  searchInput: { flex: 1, fontFamily: font.body, fontSize: 16, lineHeight: 22, color: color.ink, paddingVertical: 0 },
  feature: { marginTop: 18, marginHorizontal: space.gutter },
  featurePhoto: { height: 240, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.paperDeep },
  featureMeta: { marginTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  listRule: { height: 1, backgroundColor: color.ink, marginTop: 18 },
  row: { marginHorizontal: space.gutter, flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: color.rule },
  thumb: { width: 76, height: 76, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: color.paperDeep },
  thumbCredit: { right: 2, bottom: 2, maxWidth: '100%' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  future: { marginHorizontal: space.gutter, flexDirection: 'row', alignItems: 'baseline', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.rule, borderStyle: 'dashed' },
  futureNum: { width: 34, fontFamily: font.display, fontSize: 16, lineHeight: 22, color: color.ink3 },
  futureName: { flex: 1, fontFamily: font.body, fontSize: 16, lineHeight: 22, color: color.ink3 },
});
