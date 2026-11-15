/**
 * Technique video row (F4). Opens YouTube in the in-app browser. In mock
 * mode the ids are fake, so it shows a local placeholder thumbnail and
 * doesn't open anything.
 */
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import type { Video } from '../api';
import { placeholderVideoThumb } from '../domain/slot-photos';
import { color, font, radius } from '../theme/tokens';
import { Icon } from './icon';
import { T } from './text';

export const youtubeThumb = (id: string) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
export const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

function open(video: Video, placeholder: boolean) {
  if (placeholder) {
    Alert.alert('Placeholder video', 'Mock mode uses made-up video ids, so there’s nothing to play.');
    return;
  }
  void WebBrowser.openBrowserAsync(youtubeUrl(video.videoId));
}

export function VideoRow({ video, caption, placeholder, compact }: { video: Video; caption: string; placeholder: boolean; compact?: boolean }) {
  const source = placeholder ? placeholderVideoThumb : { uri: youtubeThumb(video.videoId) };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Watch: ${video.title}`}
      onPress={() => open(video, placeholder)}
      style={({ pressed }) => [styles.row, compact && styles.rowCompact, pressed && { opacity: 0.75 }]}
    >
      <View style={[styles.thumb, compact && styles.thumbCompact]}>
        <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        <View style={[styles.play, compact && styles.playCompact]}>
          <Icon name="play" size={compact ? 13 : 16} color={color.ink} />
        </View>
      </View>
      <View style={styles.text}>
        {compact ? (
          <T variant="small" style={styles.compactTitle} numberOfLines={2}>
            Watch: {video.title}
          </T>
        ) : (
          <T variant="h3" style={styles.title} numberOfLines={2}>
            {video.title}
          </T>
        )}
        <T variant="caption" style={{ marginTop: 3 }}>
          {caption}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  rowCompact: { gap: 12, marginTop: 20 },
  thumb: { width: 132, height: 84, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: color.paperDeep, alignItems: 'center', justifyContent: 'center' },
  thumbCompact: { width: 92, height: 58 },
  play: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(247,242,232,0.95)', alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  playCompact: { width: 28, height: 28, borderRadius: 14 },
  text: { flex: 1 },
  title: { fontSize: 17, lineHeight: 22 },
  compactTitle: { color: color.ink, fontFamily: font.bodySemi },
});
