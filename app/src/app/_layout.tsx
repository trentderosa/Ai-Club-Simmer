/**
 * Root: fonts, providers, and the auth/onboarding guards.
 * Which screens exist depends on the session status (see state/session.tsx):
 *   signed_out -> sign-in · needs_onboarding -> onboarding · ready -> the app
 */
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createBackend } from '../api';
import { config, missingConfig } from '../api/config';
import { T } from '../components/text';
import { ErrorState, LoadingState } from '../components/states';
import { FlowCacheProvider } from '../state/flow-cache';
import { SessionProvider, useSession } from '../state/session';
import { appFonts } from '../theme/fonts';
import { color, space } from '../theme/tokens';

void SplashScreen.preventAutoHideAsync();

const missing = missingConfig(config);
const backend = missing.length ? null : createBackend(config);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(appFonts);
  const fontsReady = fontsLoaded || !!fontError;

  useEffect(() => {
    if (fontsReady && !backend) void SplashScreen.hideAsync();
  }, [fontsReady]);

  if (!fontsReady) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {backend ? (
        <SessionProvider backend={backend}>
          <FlowCacheProvider>
            <RootStack />
          </FlowCacheProvider>
        </SessionProvider>
      ) : (
        <MissingConfig names={missing} />
      )}
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { status, error, refreshProfile, signOut } = useSession();

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync();
  }, [status]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <LoadingState title="Warming up the pan…" />
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ErrorState
          error={error}
          onAction={(a) => (a === 'sign_in' ? void signOut() : void refreshProfile())}
          secondary={{ label: 'Sign out', onPress: () => void signOut() }}
        />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.paper } }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={status === 'signed_out'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'needs_onboarding'}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="today" />
        <Stack.Screen name="cook-anything" />
        <Stack.Screen name="recipe/[slotId]" />
        <Stack.Screen name="cook/[slotId]" options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: color.sheet } }} />
        <Stack.Screen name="check-in/[slotId]" />
        <Stack.Screen name="complete/[slotId]" options={{ animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="generated/[recipeId]" />
        <Stack.Screen name="generated-cook/[recipeId]" options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: color.sheet } }} />
        <Stack.Screen name="generated-check-in/[recipeId]" />
        <Stack.Screen name="generated-complete/[recipeId]" options={{ animation: 'fade', gestureEnabled: false }} />
      </Stack.Protected>
    </Stack>
  );
}

function MissingConfig({ names }: { names: string[] }) {
  return (
    <View style={{ flex: 1, backgroundColor: color.paper, justifyContent: 'center', padding: space.gutter }}>
      <T variant="overline">Setup needed</T>
      <T variant="h1" style={{ marginTop: 8 }}>
        Simmer isn’t configured yet.
      </T>
      <T variant="small" style={{ marginTop: 12 }}>
        Add these to app/.env.local (see app/.env.example), or run with EXPO_PUBLIC_MOCK_MODE=1 to use fake data:
      </T>
      {names.map((n) => (
        <T key={n} variant="bodySemi" style={{ marginTop: 6 }}>
          {n}
        </T>
      ))}
    </View>
  );
}
