/**
 * Technique video row (F4). Opens an allowlisted YouTube URL with
 * React Native Linking. In mock mode placeholder videos are not openable:
 * the row is disabled and nothing is launched (no crash, no error toast).
 */
import { Image } from 'expo-image';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import type { Video } from '../api';
import { placeholderVideoThumb } from '../domain/slot-photos';
import { openableYouTubeUrl } from '../domain/youtube-url';
import { color, font, radius } from '../theme/tokens';
import { Icon } from './icon';
import { T } from './text';

export const youtubeThumb = (id: string) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

export async function openVideo(video: Video, placeholder: boolean): Promise<boolean> {
  const url = openableYouTubeUrl(video, placeholder);
  if (!url) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

export function VideoRow({ video, caption, placeholder, compact }: { video: Video; caption: string; placeholder: boolean; compact?: boolean }) {
  const source = placeholder ? placeholderVideoThumb : { uri: youtubeThumb(video.videoId) };
  const openable = openableYouTubeUrl(video, placeholder) !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={openable ? `Watch: ${video.title}` : `Preview only: ${video.title}`}
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={() => {
        void openVideo(video, placeholder);
      }}
      style={({ pressed }) => [
        styles.row,
        compact && styles.rowCompact,
        !openable && styles.disabled,
        pressed && openable && { opacity: 0.75 },
      ]}
    >
      <View style={[styles.thumb, compact && styles.thumbCompact]}>
        <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        {openable ? (
          <View style={[styles.play, compact && styles.playCompact]}>
            <Icon name="play" size={compact ? 13 : 16} color={color.ink} />
          </View>
        ) : null}
      </View>
      <View style={styles.text}>
        {compact ? (
          <T variant="small" style={styles.compactTitle} numberOfLines={2}>
            {openable ? `Watch: ${video.title}` : `Preview only: ${video.title}`}
          </T>
        ) : (
          <T variant="h3" style={styles.title} numberOfLines={2}>
            {video.title}
          </T>
        )}
        <T variant="caption" style={{ marginTop: 3 }}>
          {openable ? caption : placeholder ? 'Preview only — this isn’t a real video.' : caption}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  rowCompact: { gap: 12, marginTop: 20 },
  disabled: { opacity: 0.7 },
  thumb: { width: 132, height: 84, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: color.paperDeep, alignItems: 'center', justifyContent: 'center' },
  thumbCompact: { width: 92, height: 58 },
  play: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(247,242,232,0.95)', alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  playCompact: { width: 28, height: 28, borderRadius: 14 },
  text: { flex: 1 },
  title: { fontSize: 17, lineHeight: 22 },
  compactTitle: { color: color.ink, fontFamily: font.bodySemi },
});
