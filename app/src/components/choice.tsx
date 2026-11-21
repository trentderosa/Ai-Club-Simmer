/** Onboarding / check-in inputs: option rows, chips, a segmented rating, a text field. */
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { color, font, radius, space } from '../theme/tokens';
import { T } from './text';

/** Serif option row with a radio, split by hairlines (first row sits on an ink rule). */
export function OptionRow({ title, subtitle, selected, onPress, first }: { title: string; subtitle?: string; selected: boolean; onPress: () => void; first?: boolean }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      onPress={onPress}
      style={({ pressed }) => [styles.opt, first && styles.optFirst, pressed && { opacity: 0.7 }]}
    >
      <View style={{ flex: 1 }}>
        <T style={styles.optTitle}>{title}</T>
        {subtitle ? (
          <T variant="caption" style={styles.optSub}>
            {subtitle}
          </T>
        ) : null}
      </View>
      <View style={[styles.radio, selected && styles.radioOn]} />
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && { opacity: 0.8 }]}
    >
      <T style={[styles.chipText, selected && { color: color.paper }]}>{label}</T>
    </Pressable>
  );
}

export function Chips({ children }: { children: React.ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

export interface SegmentOption<V extends string> {
  value: V;
  title: string;
  subtitle: string;
}

/** Three-up rating control (Easy / OK / Hard) with an ink outline. */
export function Segmented<V extends string>({ options, value, onChange }: { options: readonly SegmentOption<V>[]; value: V | null; onChange: (v: V) => void }) {
  return (
    <View style={styles.seg} accessibilityRole="radiogroup">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${o.title}, ${o.subtitle}`}
            onPress={() => onChange(o.value)}
            style={[styles.segItem, i > 0 && styles.segDivider, on && styles.segOn]}
          >
            <T style={[styles.segTitle, on && { color: color.paper }]} numberOfLines={1}>
              {o.title}
            </T>
            <T variant="caption" style={[styles.segSub, on && { color: '#CFC6B6' }]} numberOfLines={1}>
              {o.subtitle}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <T style={styles.fieldLabel}>
        {label}
        {hint ? <T style={styles.fieldHint}> {hint}</T> : null}
      </T>
      <TextInput
        placeholderTextColor={color.ink3}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, input.multiline && styles.inputMulti, input.style]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  opt: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.rule },
  optFirst: { borderTopWidth: 1, borderTopColor: color.ink },
  optTitle: { fontFamily: font.display, fontSize: 20, lineHeight: 26, color: color.ink },
  optSub: { fontSize: 14, marginTop: 1 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: color.ink3 },
  radioOn: { borderWidth: 7, borderColor: color.tomato },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 15, borderRadius: radius.pill, borderWidth: 1, borderColor: color.rule, backgroundColor: color.sheet, justifyContent: 'center' },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20, color: color.ink },
  seg: { flexDirection: 'row', borderWidth: 1, borderColor: color.ink, borderRadius: radius.md, overflow: 'hidden', marginTop: space.s5 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 64, paddingVertical: space.s3, paddingHorizontal: space.s1 },
  segDivider: { borderLeftWidth: 1, borderLeftColor: color.ink },
  segOn: { backgroundColor: color.ink },
  segTitle: { fontFamily: font.display, fontSize: 20, lineHeight: 26, color: color.ink, textAlign: 'center' },
  segSub: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
  field: { marginTop: space.s5 },
  fieldLabel: { fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20, color: color.ink, marginBottom: 8 },
  fieldHint: { fontFamily: font.body, color: color.ink3 },
  input: { borderWidth: 1, borderColor: color.rule, backgroundColor: color.sheet, borderRadius: radius.sm, paddingHorizontal: space.s3, paddingVertical: space.s3, fontFamily: font.body, fontSize: 17, lineHeight: 24, color: color.ink, minHeight: 48 },
  inputMulti: { minHeight: 96, textAlignVertical: 'top' },
});
