/**
 * Minimal tab shell so Today, the recipe book and the profile are reachable.
 * Visuals live in `components/tab-bar.tsx` so Nathan can restyle them in one
 * place. Stack screens (recipe, cook, check-in, edit profile) sit above this
 * navigator and hide the tabs.
 */
import { Tabs } from 'expo-router';

import { AppTabBar } from '../../components/tab-bar';
import { color } from '../../theme/tokens';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.paper } }}
    >
      <Tabs.Screen name="today" options={{ title: 'Today', tabBarLabel: 'Today' }} />
      <Tabs.Screen name="book" options={{ title: 'Recipe book', tabBarLabel: 'Recipe book' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarLabel: 'You' }} />
    </Tabs>
  );
}
