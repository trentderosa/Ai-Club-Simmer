/**
 * Picks the backend for the current EXPO_PUBLIC_MOCK_MODE.
 *   off -> Supabase + ai-server
 *   all -> everything mocked (no network)
 *   ai  -> real Supabase, mocked ai-server (recipes, user_recipes id, check-ins)
 */
import type { AppConfig } from './config';
import type { Backend } from './backend';
import { createLiveBackend } from './live-backend';
import { createMockBackend } from './mock/mock-backend';

export function createBackend(c: AppConfig): Backend {
  if (c.mockMode === 'all') return createMockBackend({ xpStatus: c.mockXpStatus });
  const live = createLiveBackend({ supabaseUrl: c.supabaseUrl, supabaseAnonKey: c.supabaseAnonKey, ai: c.aiServerUrl });
  if (c.mockMode === 'off') return live;
  // `ai`: the mock's recipe/check-in calls only need a signed-in mock session.
  const mock = createMockBackend({ xpStatus: c.mockXpStatus, startSignedIn: true, skipGating: true });
  return {
    ...live,
    label: 'mock-ai',
    generateRecipe: mock.generateRecipe,
    getUserRecipeId: mock.getUserRecipeId,
    submitCheckIn: mock.submitCheckIn,
    cookAnything: mock.cookAnything,
    getGeneratedRecipe: mock.getGeneratedRecipe,
  };
}

export type { AppSession, Backend } from './backend';
export { ApiError, isApiError } from './errors';
export * from './schemas';
