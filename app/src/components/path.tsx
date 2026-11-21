/**
 * The "Weeknight basics" path: a quiet ink timeline of 10 nodes in a gentle
 * zig-zag. Done = ink dot with a check, current = tomato ring, locked =
 * dashed. The final slot (mastery challenge) is a rounded diamond.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path as SvgPath } from 'react-native-svg';

import type { PlanSlot } from '../api';
import { color, font, space } from '../theme/tokens';
import { Icon } from './icon';
import { T } from './text';

const ROW = 78;
const DOT = 56;
const GAP = 14;
const TOP = 8;
/**
 * Horizontal offsets, one per slot. The mockup uses 0/36/72/96; these are
 * scaled down a little because the static Fraunces cut sets wider than the
 * mockup's optical-size 24 variable font, and long names need the room.
 */
const XS = [0, 28, 56, 76, 56, 28, 0, 28, 56, 76];

const offsetFor = (i: number) => XS[i % XS.length];
const centerX = (i: number) => offsetFor(i) + GAP + DOT / 2;
const centerY = (i: number) => TOP + ROW / 2 + i * ROW;

export function PathList({ slots, onOpen }: { slots: PlanSlot[]; onOpen: (slot: PlanSlot) => void }) {
  const [width, setWidth] = useState(0);
  const segments = slots.slice(0, -1).map((s, i) => {
    const [x1, y1, x2, y2] = [centerX(i), centerY(i), centerX(i + 1), centerY(i + 1)];
    const my = (y1 + y2) / 2;
    const solid = s.status === 'done' && slots[i + 1].status !== 'locked';
    return (
      <SvgPath
        key={s.slot_id}
        d={`M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`}
        stroke={solid ? color.ink : color.pathFuture}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={solid ? undefined : '1 7'}
        fill="none"
      />
    );
  });

  const height = TOP + slots.length * ROW + 8;
  return (
    <View
      style={styles.wrap}
      onLayout={(e) => {
        const next = Math.round(e.nativeEvent.layout.width);
        setWidth((prev) => (prev === next ? prev : next));
      }}
    >
      {width > 0 ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
          {segments}
        </Svg>
      ) : null}
      {slots.map((s, i) => (
        <PathNode key={s.slot_id} slot={s} offset={offsetFor(i)} onPress={() => onOpen(s)} />
      ))}
    </View>
  );
}

function PathNode({ slot, offset, onPress }: { slot: PlanSlot; offset: number; onPress: () => void }) {
  const { status, is_final: final } = slot;
  const open = status !== 'locked';
  const label = final ? 'Mastery challenge' : slot.technique_focus;
  return (
    <Pressable
      onPress={open ? onPress : undefined}
      disabled={!open}
      accessibilityRole="button"
      accessibilityState={{ disabled: !open }}
      accessibilityLabel={`${slot.slot_order}. ${slot.dish_name}, ${status === 'done' ? 'done' : status === 'current' ? 'up next' : 'locked'}, ${slot.xp_value} XP`}
      style={({ pressed }) => [styles.node, { paddingLeft: offset + GAP }, pressed && open && { opacity: 0.7 }]}
    >
      <View style={styles.dotBox}>
        {status === 'current' ? <View style={[styles.halo, final && styles.diamond]} /> : null}
        <View style={[styles.dot, styles[status], final && styles.diamond]}>
          <View style={final ? styles.unrotate : undefined}>
            {status === 'done' ? (
              <Icon name="check" color={color.paper} size={24} />
            ) : final && status === 'locked' ? (
              <Icon name="trophy" color={color.lockedText} size={22} />
            ) : (
              <T style={[styles.num, status === 'current' ? styles.numCurrent : styles.numLocked]}>{slot.slot_order}</T>
            )}
          </View>
        </View>
      </View>
      <View style={styles.text}>
        {status === 'current' ? (
          <T variant="overline" style={styles.upNext}>
            Up next
          </T>
        ) : null}
        <T numberOfLines={1} style={[styles.name, status === 'locked' && { color: color.ink3 }, status === 'current' && { color: color.tomatoDeep }]}>
          {slot.dish_name}
        </T>
        <T variant="caption" numberOfLines={1}>
          {label} · <T variant="caption" style={styles.xp}>{slot.xp_value} XP</T>
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: TOP, paddingBottom: 8, marginHorizontal: space.gutter },
  node: { height: ROW, flexDirection: 'row', alignItems: 'center' },
  dotBox: { width: DOT, height: DOT, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: DOT + 16, height: DOT + 16, borderRadius: (DOT + 16) / 2, borderWidth: 1, borderColor: color.tomato, opacity: 0.35 },
  done: { backgroundColor: color.ink },
  current: { backgroundColor: color.sheet, borderWidth: 2, borderColor: color.tomato },
  locked: { backgroundColor: color.paper, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.lockedRing },
  diamond: { borderRadius: 14, transform: [{ rotate: '45deg' }], width: DOT - 6, height: DOT - 6 },
  unrotate: { transform: [{ rotate: '-45deg' }] },
  num: { fontFamily: font.display, fontSize: 20, lineHeight: 24 },
  numCurrent: { color: color.tomato, fontSize: 22 },
  numLocked: { color: color.lockedText },
  text: { flex: 1, marginLeft: GAP },
  upNext: { fontSize: 11, lineHeight: 14 },
  name: { fontFamily: font.display, fontSize: 18, lineHeight: 22, color: color.ink },
  xp: { fontFamily: font.bodyBold, color: color.ink2 },
});
