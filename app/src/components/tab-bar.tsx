/**
 * Bottom navigation (Today, Recipe book, You). Nathan owns UI/UX, so keep
 * the styling in this one component: colors, type and icons all come from
 * the Direction A tokens. Expo Router's tab layout points `tabBar` here.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { color } from '../theme/tokens';
import { Icon, type IconName } from './icon';
import { T } from './text';

const ICONS: Record<string, IconName> = {
  today: 'path',
  book: 'book',
  profile: 'user',
};

/**
 * Expo Router 58's tabBar render props (`BottomTabBarProps`): `navigateToTab`
 * and `emitter` instead of a React Navigation `navigation` object.
 */
export interface AppTabBarProps {
  state: { index: number; routes: { key: string; name: string; params?: object }[] };
  descriptors: Record<string, { options: { tabBarLabel?: unknown; title?: string } }>;
  emitter: {
    emit: (event: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
  };
  navigateToTab: (routeKey: string) => void;
  insets: { bottom: number };
}

export function AppTabBar({ state, descriptors, emitter, navigateToTab, insets }: AppTabBarProps) {
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const { options } = descriptors[route.key];
        const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : (options.title ?? route.name);
        const icon = ICONS[route.name] ?? 'path';
        const onPress = () => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            onPress={onPress}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.7 }]}
          >
            <Icon name={icon} size={24} color={focused ? color.tomato : color.ink3} />
            <T variant="tab" color={focused ? 'ink' : 'ink3'}>
              {label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.rule,
    paddingTop: 9,
  },
  item: { width: 84, alignItems: 'center', gap: 3, minHeight: 44, paddingVertical: 2 },
});
