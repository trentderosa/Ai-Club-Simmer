/** Letterpress badge seal from the mockups (F9). Kind sets the colors. */
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import type { CheckInBadge } from '../api';
import { font } from '../theme/tokens';
import { T } from './text';

const PALETTE = {
  completion: { fill: '#FFFDF8', ring: '#1F1B16', text: '#1F1B16' },
  mastery: { fill: '#C8402B', ring: '#9E2F1E', text: '#FFF8F2' },
  path_milestone: { fill: '#F7E9C2', ring: '#8A6514', text: '#5E450C' },
  muted: { fill: '#EFE6D3', ring: '#C9BEAA', text: '#AFA593' },
} as const;

export function Seal({
  label,
  kind,
  size = 84,
  earned = true,
}: {
  label: string;
  kind: CheckInBadge['kind'];
  size?: number;
  /** Unearned badges are grayed out (F9). */
  earned?: boolean;
}) {
  const p = earned ? PALETTE[kind] : PALETTE.muted;
  const ticks = Array.from({ length: 24 }, (_, i) => i * 15);
  return (
    <View style={[styles.wrap, { width: size, height: size }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg viewBox="0 0 100 100" width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={50} cy={50} r={42} fill={p.fill} stroke={p.ring} strokeWidth={2} />
        {ticks.map((a) => (
          <Line key={a} x1={50} y1={3} x2={50} y2={8} stroke={p.ring} strokeWidth={1.6} transform={`rotate(${a} 50 50)`} />
        ))}
        {kind === 'mastery' && earned ? (
          <Circle cx={50} cy={50} r={36} fill="none" stroke="#FFF8F2" strokeWidth={1} opacity={0.6} />
        ) : (
          <Circle cx={50} cy={50} r={36} fill="none" stroke={p.ring} strokeWidth={1} strokeDasharray="2 3" />
        )}
        {kind === 'path_milestone' ? <Circle cx={50} cy={50} r={31} fill="none" stroke={p.ring} strokeWidth={1} /> : null}
      </Svg>
      <T style={{ fontFamily: font.display, fontSize: size * 0.29, lineHeight: size * 0.36, color: p.text }}>{label}</T>
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { alignItems: 'center', justifyContent: 'center' } });
