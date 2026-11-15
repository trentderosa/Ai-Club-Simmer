/**
 * Page scaffolding: safe-area screen, top bar, sticky footer, rules and
 * section heads. Hierarchy comes from rules and type, not cards or shadows.
 */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, space } from '../theme/tokens';
import { T } from './text';

export function Screen({
  children,
  footer,
  background = color.paper,
  scroll = true,
  edges = ['top'],
  contentStyle,
}: {
  children: ReactNode;
  /** Sticky footer (primary action), sits on a hairline like the mockups. */
  footer?: ReactNode;
  background?: string;
  scroll?: boolean;
  edges?: ('top' | 'bottom')[];
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaView edges={edges} style={[styles.fill, { backgroundColor: background }]}>
      {scroll ? (
        <ScrollView style={styles.fill} contentContainerStyle={[styles.content, contentStyle]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, contentStyle]}>{children}</View>
      )}
      {footer ? (
        <View style={[styles.footer, { backgroundColor: background, paddingBottom: Math.max(insets.bottom, 12) + 12 }]}>{footer}</View>
      ) : null}
    </SafeAreaView>
  );
}

export function TopBar({ left, title, right }: { left?: ReactNode; title?: string; right?: ReactNode }) {
  return (
    <View style={styles.topbar}>
      <View style={styles.side}>{left}</View>
      {title ? (
        <T variant="byline" color="ink3" numberOfLines={1} style={styles.title}>
          {title}
        </T>
      ) : (
        <View style={styles.title} />
      )}
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

export function Rule({ strong, dashed, style }: { strong?: boolean; dashed?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        dashed ? { borderTopWidth: 1, borderStyle: 'dashed', borderColor: color.rule } : { height: 1, backgroundColor: strong ? color.ink : color.rule },
        style,
      ]}
    />
  );
}

/** "Ingredients ...... 13 items" over a 1px ink rule. */
export function SectionHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <View style={styles.sh}>
      <T variant="h2" accessibilityRole="header">
        {title}
      </T>
      {typeof aside === 'string' ? <T variant="caption">{aside}</T> : aside}
    </View>
  );
}

export const gutter = { paddingHorizontal: space.gutter } as const;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: space.s8 },
  footer: { paddingHorizontal: space.gutter, paddingTop: 12, borderTopWidth: 1, borderTopColor: color.rule, flexDirection: 'row', gap: 12 },
  topbar: { height: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 16 },
  side: { width: 48, alignItems: 'flex-start' },
  sideRight: { alignItems: 'flex-end' },
  title: { flex: 1, textAlign: 'center' },
  sh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: color.ink },
});
