/**
 * Dish photo for a recipe background. Uses the Commons image when we have
 * one, and the cutting-board photo when we don't or the image fails to load.
 * The credit line stays with the photo, on a small ink chip so it stays
 * readable. On a recipe hero it opens the Commons file page; on a tappable
 * card it stays text so the card's own press still opens the recipe.
 * List thumbnails can pass showCredit={false}: a 72px image can't hold the line.
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { DishPhoto } from '../api';
import { heroPhotoForGenerated } from '../domain/generated-recipe-photo';
import { color } from '../theme/tokens';
import { T } from './text';

export function DishPhotoFill({
  photo,
  linkCredit = false,
  showCredit = true,
  creditAt = 'bottom',
  creditStyle,
}: {
  photo: DishPhoto | null | undefined;
  linkCredit?: boolean;
  /** Small thumbnails skip the credit; the feature photo and recipe hero still show it. */
  showCredit?: boolean;
  creditAt?: 'top' | 'bottom';
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
      {showCredit ? (
        openSource ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={hero.credit}
            onPress={openSource}
            hitSlop={6}
            style={[styles.creditHit, creditAt === 'top' ? styles.creditTop : styles.creditBottom, creditStyle]}
          >
            <T style={styles.credit} numberOfLines={1}>
              {hero.credit}
            </T>
          </Pressable>
        ) : (
          <T style={[styles.credit, styles.creditHit, creditAt === 'top' ? styles.creditTop : styles.creditBottom, creditStyle]} numberOfLines={1}>
            {hero.credit}
          </T>
        )
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  creditHit: {
    position: 'absolute',
    right: 8,
    maxWidth: '78%',
    backgroundColor: 'rgba(31,27,22,0.62)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  creditBottom: { bottom: 8 },
  creditTop: { top: 8 },
  credit: { fontSize: 11, lineHeight: 14, color: color.sheet },
});
