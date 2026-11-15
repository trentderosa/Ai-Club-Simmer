/**
 * Inline cook-mode timer. Idle = ink outline, running = solid ink with a
 * tomato pause button (as in the mockup). The state machine is in
 * domain/timer.ts; this only renders it and ticks it.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { adjustTimer, formatClock, pauseTimer, resetTimer, startTimer, tickTimer, type TimerState } from '../domain/timer';
import { color, font, radius } from '../theme/tokens';
import { Icon } from './icon';
import { T } from './text';

const LABEL: Record<TimerState['status'], string> = { idle: 'Timer', running: 'Running', paused: 'Paused', done: 'Time’s up' };

export function TimerCard({ timer, onChange }: { timer: TimerState; onChange: (t: TimerState) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const running = timer.status === 'running';

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const next = tickTimer(timer, t);
      if (next.status !== timer.status) onChange(next);
    }, 250);
    return () => clearInterval(id);
  }, [running, timer, onChange]);

  const remainingMs = running && timer.endsAt !== null ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
  const dark = running;
  const fg = dark ? color.paper : color.ink;

  const toggle = () => {
    const t = Date.now();
    setNow(t);
    if (timer.status === 'running') onChange(pauseTimer(timer, t));
    else if (timer.status === 'done') onChange(resetTimer(timer));
    else onChange(startTimer(timer, t));
  };

  return (
    <View style={[styles.card, dark ? styles.dark : styles.idle, timer.status === 'done' && styles.done]}>
      <View style={{ flex: 1 }}>
        <T style={[styles.label, { color: fg }]}>{LABEL[timer.status]}</T>
        <T style={[styles.time, { color: fg }]} accessibilityLabel={`${Math.ceil(remainingMs / 1000)} seconds left`} accessibilityLiveRegion="polite">
          {formatClock(remainingMs / 1000)}
        </T>
      </View>
      {timer.status !== 'running' && timer.status !== 'done' ? (
        <View style={styles.adjust}>
          <SmallButton icon="minus" label="30 seconds less" onPress={() => onChange(adjustTimer(timer, -30, Date.now()))} />
          <SmallButton icon="plus" label="30 seconds more" onPress={() => onChange(adjustTimer(timer, 30, Date.now()))} />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={timer.status === 'running' ? 'Pause timer' : timer.status === 'done' ? 'Reset timer' : 'Start timer'}
        onPress={toggle}
        style={({ pressed }) => [styles.go, pressed && { opacity: 0.85 }]}
      >
        <Icon name={timer.status === 'running' ? 'pause' : timer.status === 'done' ? 'reset' : 'play'} color="#FFFFFF" size={22} />
      </Pressable>
    </View>
  );
}

function SmallButton({ icon, label, onPress }: { icon: 'minus' | 'plus'; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.small, pressed && { opacity: 0.6 }]}>
      <Icon name={icon} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.md },
  idle: { borderWidth: 1.5, borderColor: color.ink },
  dark: { backgroundColor: color.ink },
  done: { borderColor: color.tomato },
  label: { fontFamily: font.bodyBold, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', opacity: 0.6 },
  time: { fontFamily: font.displayRegular, fontSize: 38, lineHeight: 44, fontVariant: ['tabular-nums'] },
  adjust: { flexDirection: 'row', gap: 6 },
  small: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: color.rule, alignItems: 'center', justifyContent: 'center' },
  go: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.tomato, alignItems: 'center', justifyContent: 'center' },
});
