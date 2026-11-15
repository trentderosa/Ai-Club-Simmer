/**
 * Hand-drawn pot with drifting steam (session complete). The steam loops
 * every 3.2 s and stays still when the OS asks for reduced motion.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { color } from '../theme/tokens';

function Steam({ d, delay, still }: { d: string; delay: number; still: boolean }) {
  const [t] = useState(() => new Animated.Value(still ? 0.5 : 0));
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(t, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t, delay, still]);
  const opacity = still ? 0.8 : t.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0.9, 0] });
  const translateY = still ? 0 : t.interpolate({ inputRange: [0, 1], outputRange: [8, -14] });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity, transform: [{ translateY }] }]}>
      <Svg width={200} height={140} viewBox="0 0 200 140">
        <Path d={d} stroke={color.ink3} strokeWidth={1.6} fill="none" strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}

export function PotIllustration({ reduceMotion }: { reduceMotion?: boolean }) {
  const [still, setStill] = useState(!!reduceMotion);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setStill(v || !!reduceMotion));
    return () => {
      alive = false;
    };
  }, [reduceMotion]);
  return (
    <View style={styles.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Steam d="M78 42c-6-8 6-12 0-22" delay={0} still={still} key={`a${still}`} />
      <Steam d="M100 40c-6-8 6-12 0-24" delay={700} still={still} key={`b${still}`} />
      <Steam d="M122 42c-6-8 6-12 0-22" delay={1400} still={still} key={`c${still}`} />
      <Svg width={200} height={140} viewBox="0 0 200 140" fill="none" stroke={color.ink} strokeWidth={2} strokeLinecap="round">
        <Path d="M40 70h120" />
        <Path d="M46 70c0 34 18 52 54 52s54-18 54-52" />
        <Path d="M160 76c10 0 18 3 22-2" />
        <Path d="M40 76c-10 0-18 3-22-2" />
        <Path d="M54 80c15 5 31 5 46 0s31-5 46 0" stroke={color.tomato} strokeWidth={2.4} />
        <Circle cx={72} cy={66} r={5} fill={color.herb} stroke="none" />
        <Circle cx={92} cy={64} r={6} fill={color.tomato} stroke="none" />
        <Circle cx={114} cy={67} r={4.5} fill={color.butter} stroke="none" />
        <Circle cx={130} cy={65} r={5} fill={color.herb} stroke="none" />
        <Path d="M30 128h140" stroke={color.rule} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { width: 200, height: 140, alignSelf: 'center' } });
