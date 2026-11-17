/**
 * Dish photo for a recipe background. Uses the Commons image when we have
 * one, and the cutting-board photo when we don't or the image fails to load.
 * The credit line stays with the photo. On a recipe hero it opens the
 * Commons file page; on a tappable card it stays text so the card's own
 * press still opens the recipe.
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { DishPhoto } from '../api';
import { heroPhotoForGenerated } from '../domain/generated-recipe-photo';
import { T } from './text';

export function DishPhotoFill({
  photo,
  linkCredit = false,
  creditStyle,
}: {
  photo: DishPhoto | null | undefined;
  linkCredit?: boolean;
  creditStyle?: StyleProp<ViewStyle>;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const hero = imageFailed ? heroPhotoForGenerated(null) : heroPhotoForGenerated(photo);
  const openSource = linkCredit && hero.sourceUrl
    ? () => {
        void Linking.openURL(hero.sourceUrl as string);
      }
    : undefined;
  return (
    <>
      <Image
        source={hero.source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        accessibilityIgnoresInvertColors
        onError={() => setImageFailed(true)}
      />
      {openSource ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={hero.credit}
          onPress={openSource}
          style={[styles.creditHit, creditStyle]}
        >
          <T style={styles.credit} numberOfLines={1}>
            {hero.credit}
          </T>
        </Pressable>
      ) : (
        <T style={[styles.credit, styles.creditHit, creditStyle]} numberOfLines={1}>
          {hero.credit}
        </T>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  creditHit: { position: 'absolute', right: 10, bottom: 8, maxWidth: '70%' },
  credit: { fontSize: 10, lineHeight: 13, color: 'rgba(255,255,255,0.85)', letterSpacing: 0.3 },
});
