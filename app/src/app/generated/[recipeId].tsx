/**
 * Generated recipe detail for a free-form "Cook anything" dish.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Recipe, Video, Videos } from '../../api';
import { Button, IconButton } from '../../components/button';
import { DishPhotoFill } from '../../components/dish-photo';
import { pageColumn, SectionHead } from '../../components/layout';
import { ErrorState, LoadingState } from '../../components/states';
import { T } from '../../components/text';
import { VideoRow } from '../../components/video';
import { useSession } from '../../state/session';
import { useErrorAction } from '../../state/use-error-action';
import { useGeneratedRecipe } from '../../state/use-generated-recipe';
import { color, font, radius, space } from '../../theme/tokens';

const INGREDIENTS_PREVIEW = 7;

function param(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default function GeneratedRecipeScreen() {
  const recipeId = param(useLocalSearchParams<{ recipeId: string }>().recipeId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { backend } = useSession();
  const data = useGeneratedRecipe(recipeId);
  const onError = useErrorAction(data.reload);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  if (data.status !== 'ready') {
    return (
      <View style={styles.fill}>
        <View style={[styles.fill, pageColumn]}>
        <View style={[styles.bar, { paddingTop: insets.top }]}>
          <IconButton icon="back" label="Back" onPress={back} />
        </View>
        {data.status === 'error' ? (
          <ErrorState error={data.error} onAction={onError} />
        ) : (
          <LoadingState title="Opening your recipe…" />
        )}
        </View>
      </View>
    );
  }

  const res = data.data;
  const { recipe, videos } = res;

  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={[pageColumn, styles.scroll]}>
        <View style={styles.hero}>
          <DishPhotoFill key={res.photo?.url ?? 'none'} photo={res.photo} linkCredit />
          <View style={[styles.float, { top: insets.top + 4 }]}>
            <IconButton icon="back" label="Back" onPress={back} filled />
          </View>
        </View>

        <View style={styles.titleBlock}>
          <T variant="overline">Cook anything{res.cached ? ' · Saved recipe' : ''}</T>
          <T variant="h1" style={styles.title} accessibilityRole="header">
            {recipe.title}
          </T>
          <T variant="small" style={{ marginTop: 10 }}>
            Written for your kitchen. Cooking it again uses this same recipe, so the XP stays the same.
          </T>
        </View>

        <View style={styles.facts}>
          <Fact value={`${recipe.timeEstimateMinutes} min`} label="Time" />
          <Fact value={String(recipe.steps.length)} label="Steps" divider />
          <Fact value={String(res.xp_value)} label="XP" divider />
        </View>

        {recipe.coachNote ? (
          <View style={styles.note}>
            <T variant="overline" style={{ color: color.butterInk }}>
              Coach’s note
            </T>
            <T style={styles.noteText}>{recipe.coachNote}</T>
          </View>
        ) : null}

        <Ingredients recipe={recipe} />
        <VideoSection recipe={recipe} videos={videos} placeholder={backend.label !== 'live'} />
        <DishVideoSection videos={res.dish_videos} placeholder={backend.label !== 'live'} />
      </ScrollView>

      <View style={[styles.footerBar, { paddingBottom: Math.max(insets.bottom, space.s3) + space.s3 }]}>
        <View style={[pageColumn, styles.footer]}>
          <Button
            label="Start cooking"
            onPress={() => router.push({ pathname: '/generated-cook/[recipeId]', params: { recipeId: res.generated_recipe_id } })}
            style={styles.footerBtn}
          />
        </View>
      </View>
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
  bar: { minHeight: 56, justifyContent: 'center', paddingHorizontal: space.s3 },
  hero: { height: 280, backgroundColor: color.paperDeep, overflow: 'hidden' },
  float: { position: 'absolute', left: space.s3 },
  titleBlock: { paddingTop: space.s5, paddingHorizontal: space.gutter },
  title: { marginTop: space.s2, fontSize: 34, lineHeight: 40 },
  facts: { flexDirection: 'row', marginTop: space.s5, marginHorizontal: space.gutter, borderTopWidth: 1, borderTopColor: color.ink, borderBottomWidth: 1, borderBottomColor: color.rule },
  fact: { flex: 1, alignItems: 'center', paddingVertical: space.s3 },
  factDivider: { borderLeftWidth: 1, borderLeftColor: color.rule },
  factValue: { fontFamily: font.display, fontSize: 22, lineHeight: 28, textAlign: 'center', fontVariant: ['tabular-nums'] },
  note: { marginTop: space.s5, marginHorizontal: space.gutter, paddingVertical: space.s4, paddingHorizontal: space.s4, backgroundColor: color.butterWash, borderRadius: radius.sm },
  noteText: { fontFamily: font.displayRegular, fontSize: 16, lineHeight: 23, marginTop: space.s1 },
  sec: { marginTop: space.s8, marginHorizontal: space.gutter },
  ing: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space.s3, minHeight: 48, borderBottomWidth: 1, borderBottomColor: color.ruleSoft },
  amount: { width: 112, paddingRight: space.s3 },
  footerBar: { backgroundColor: color.paper, borderTopWidth: 1, borderTopColor: color.rule },
  footer: { flexDirection: 'row', paddingHorizontal: space.gutter, paddingTop: space.s3 },
  footerBtn: { flex: 1 },
});
