/**
 * The app's only Supabase client. Uses the public anon key and the signed-in
 * user's session; Row Level Security decides what the user can read and write.
 * Server-only keys must never be referenced anywhere in app/ (enforced by
 * `npm run check:secrets` and an ESLint rule).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import 'react-native-url-polyfill/auto';

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      // AsyncStorage persists the session on iOS/Android; on web it's localStorage.
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  });
}
