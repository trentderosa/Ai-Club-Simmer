import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius } from '../theme/tokens';
import { Icon, type IconName } from './icon';
import { T } from './text';

/** primary = tomato (the screen's one next action); ink = dark; outline; quiet = text-only. */
export type ButtonKind = 'primary' | 'ink' | 'outline' | 'quiet';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  loading?: boolean;
  trailingIcon?: IconName;
  style?: StyleProp<ViewStyle>;
  /** Cook mode uses taller (72) controls. */
  size?: 'default' | 'large';
  accessibilityHint?: string;
}

const fg: Record<ButtonKind, string> = { primary: color.onAccent, ink: color.paper, outline: color.ink, quiet: color.ink2 };

export function Button({ label, onPress, kind = 'primary', disabled, loading, trailingIcon, style, size = 'default', accessibilityHint }: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'large' && styles.large,
        styles[kind],
        inactive && styles.disabled,
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg[kind]} />
      ) : (
        <View style={styles.row}>
          <T variant="button" style={[{ color: fg[kind] }, size === 'large' && styles.largeLabel]}>
            {label}
          </T>
          {trailingIcon ? <Icon name={trailingIcon} color={fg[kind]} size={size === 'large' ? 22 : 20} /> : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { height: 54, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  large: { height: 72 },
  largeLabel: { fontSize: 20, lineHeight: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  primary: { backgroundColor: color.tomato },
  ink: { backgroundColor: color.ink },
  outline: { borderWidth: 1.5, borderColor: color.ink },
  quiet: { height: 44 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
});

/** Round 40x40 icon button (back, close). */
export function IconButton({ icon, onPress, label, tint = color.ink, filled }: { icon: IconName; onPress: () => void; label: string; tint?: string; filled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [iconStyles.btn, filled && iconStyles.filled, pressed && { opacity: 0.7 }]}
    >
      <Icon name={icon} color={tint} />
    </Pressable>
  );
}

const iconStyles = StyleSheet.create({
  btn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  filled: { backgroundColor: 'rgba(247,242,232,0.94)' },
});
