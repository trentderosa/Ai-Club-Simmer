import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { errorCopy } from '../domain/error-messages';
import { PASSWORD_RECOVERY_OWNER_KEY, PASSWORD_RESET_EMAIL_LIMIT_COPY } from '../domain/password-reset';
import type { AuthChange } from '../domain/password-reset';
import { createLiveBackend } from './live-backend';
import type { Backend } from './backend';
import { ApiError } from './errors';

type FakeSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: {
    id: string;
    aud: string;
    email: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
    created_at: string;
  };
};

type ResetError = { message: string; status?: number; code?: string };

type FakeAuth = {
  session: FakeSession | null;
  handlers: ((event: string, session: FakeSession | null) => void)[];
  onGetSession: (() => void) | null;
  updateCalls: number;
  resetError: ResetError | null;
  emit: (event: string, session: FakeSession | null) => void;
};

type FakeLinking = {
  initial: string | null;
  handler: ((event: { url: string }) => void) | null;
};

jest.mock('@react-native-async-storage/async-storage', () => {
  const memory = new Map<string, string>();
  (globalThis as { __simmerRecoveryStore?: Map<string, string> }).__simmerRecoveryStore = memory;
  return {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: async (key: string) => {
      memory.delete(key);
    },
  };
});

jest.mock('expo-linking', () => {
  const linking: FakeLinking = { initial: null, handler: null };
  (globalThis as { __simmerFakeLinking?: FakeLinking }).__simmerFakeLinking = linking;
  return {
    createURL: (path: string) => `simmer://${path}`,
    getInitialURL: async () => linking.initial,
    addEventListener: (_event: string, handler: (event: { url: string }) => void) => {
      linking.handler = handler;
      return {
        remove: () => {
          linking.handler = null;
        },
      };
    },
  };
});

jest.mock('./supabase', () => {
  const handlers: FakeAuth['handlers'] = [];
  const state: FakeAuth = {
    session: null,
    handlers,
    onGetSession: null,
    updateCalls: 0,
    resetError: null,
    emit(event, session) {
      state.session = session;
      for (const handler of handlers) handler(event, session);
    },
  };
  (globalThis as { __simmerFakeAuth?: FakeAuth }).__simmerFakeAuth = state;
  return {
    createSupabaseClient: () => ({
      auth: {
        onAuthStateChange: (cb: (event: string, session: FakeSession | null) => void) => {
          handlers.push(cb);
          return { data: { subscription: { unsubscribe() {} } } };
        },
        getSession: async () => {
          state.onGetSession?.();
          return { data: { session: state.session }, error: null };
        },
        updateUser: async () => {
          state.updateCalls += 1;
          return { data: { user: state.session?.user ?? null }, error: null };
        },
        setSession: async () => ({ data: { session: state.session, user: state.session?.user ?? null }, error: null }),
        exchangeCodeForSession: async () => ({ data: { session: state.session }, error: null }),
        resetPasswordForEmail: async () => ({ data: {}, error: state.resetError }),
        signInWithPassword: async () => ({ data: { session: state.session }, error: null }),
        signUp: async () => ({ data: { session: null, user: null }, error: null }),
        signOut: async () => ({ error: null }),
        startAutoRefresh: () => undefined,
        stopAutoRefresh: () => undefined,
      },
    }),
  };
});

function authState(): FakeAuth {
  const state = (globalThis as { __simmerFakeAuth?: FakeAuth }).__simmerFakeAuth;
  if (!state) throw new Error('missing fake auth');
  return state;
}

function linkingState(): FakeLinking {
  const linking = (globalThis as { __simmerFakeLinking?: FakeLinking }).__simmerFakeLinking;
  if (!linking) throw new Error('missing fake linking');
  return linking;
}

function recoveryStore(): Map<string, string> {
  const memory = (globalThis as { __simmerRecoveryStore?: Map<string, string> }).__simmerRecoveryStore;
  if (!memory) throw new Error('missing recovery store');
  return memory;
}

function sessionFor(id: string, accessToken = `access-${id}`): FakeSession {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${id}`,
    expires_in: 3600,
    expires_at: 1_800_000_000,
    token_type: 'bearer',
    user: {
      id,
      aud: 'authenticated',
      email: `${id}@simmer.invalid`,
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function setPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

function setHref(href: string) {
  let current = href;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        get href() {
          return current;
        },
      },
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, next: string) {
          current = next;
        },
      },
    },
  });
}

function openBackend(): Backend {
  return createLiveBackend({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-test-key',
    ai: 'https://ai.example.invalid',
  });
}

/** prepareAuth leaves startup true until the queued restore event can land. */
async function pastStartup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  recoveryStore().clear();
  const auth = authState();
  auth.session = null;
  auth.handlers.length = 0;
  auth.onGetSession = null;
  auth.updateCalls = 0;
  auth.resetError = null;
  const linking = linkingState();
  linking.initial = null;
  linking.handler = null;
  setPlatform('web');
  setHref('http://localhost:8081/');
});

describe('live password recovery', () => {
  it('accepts PASSWORD_RECOVERY for that user only', async () => {
    const auth = authState();
    const backend = openBackend();
    await backend.prepareAuth();
    auth.emit('PASSWORD_RECOVERY', sessionFor('user-a'));

    expect(backend.passwordRecoveryPending()).toBe(true);
    expect(backend.passwordRecoveryFailed()).toBe(false);
    expect(backend.passwordResetOwns('user-a')).toBe(true);
    expect(backend.passwordResetOwns('user-b')).toBe(false);

    await backend.updatePassword('longenough');
    expect(auth.updateCalls).toBe(1);
  });

  it('keeps recovery on a same-user SIGNED_IN and clears it for a different user', async () => {
    await AsyncStorage.setItem(PASSWORD_RECOVERY_OWNER_KEY, 'user-a');
    const auth = authState();
    auth.session = sessionFor('user-a');
    auth.onGetSession = () => {
      auth.onGetSession = null;
      auth.emit('SIGNED_IN', auth.session);
    };
    const restored = openBackend();
    await restored.prepareAuth();

    expect(restored.passwordRecoveryPending()).toBe(true);
    expect(restored.passwordRecoveryFailed()).toBe(false);
    expect(restored.passwordResetOwns('user-a')).toBe(true);

    await pastStartup();
    auth.emit('SIGNED_IN', sessionFor('user-a'));

    expect(restored.passwordRecoveryPending()).toBe(true);
    expect(restored.passwordResetOwns('user-a')).toBe(true);
    await restored.updatePassword('longenough');
    expect(auth.updateCalls).toBe(1);

    auth.emit('SIGNED_IN', sessionFor('user-b'));
    expect(restored.passwordRecoveryPending()).toBe(false);
    expect(restored.passwordResetOwns('user-a')).toBe(false);
    expect(restored.passwordResetOwns('user-b')).toBe(false);
    expect(await AsyncStorage.getItem(PASSWORD_RECOVERY_OWNER_KEY)).toBeNull();
    await expect(restored.updatePassword('longenough')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(auth.updateCalls).toBe(1);
  });

  it('shows a failure immediately for an expired simmer link while the app is open', async () => {
    setPlatform('ios');
    const auth = authState();
    auth.session = sessionFor('user-b');
    const backend = openBackend();
    const changes: AuthChange[] = [];
    backend.onSessionChange((_session, change) => {
      changes.push(change);
    });
    await backend.prepareAuth();
    expect(backend.passwordRecoveryFailed()).toBe(false);

    const handler = linkingState().handler;
    expect(handler).not.toBeNull();
    await handler?.({ url: 'simmer://reset-password#error=access_denied&error_code=otp_expired' });

    expect(changes).toContain('password_recovery_failed');
    expect(backend.passwordRecoveryFailed()).toBe(true);
    expect(backend.passwordRecoveryPending()).toBe(false);
    expect(backend.passwordResetOwns('user-b')).toBe(false);
    await expect(backend.updatePassword('longenough')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(auth.updateCalls).toBe(0);
  });

  it('refuses updatePassword when the session is a different user', async () => {
    const auth = authState();
    const backend = openBackend();
    await backend.prepareAuth();
    auth.emit('PASSWORD_RECOVERY', sessionFor('user-a'));
    auth.session = sessionFor('user-b');

    expect(backend.passwordRecoveryPending()).toBe(true);
    expect(backend.passwordRecoveryFailed()).toBe(false);
    expect(backend.passwordResetOwns('user-a')).toBe(true);
    expect(backend.passwordResetOwns('user-b')).toBe(false);
    await expect(backend.updatePassword('longenough')).rejects.toBeInstanceOf(ApiError);
    await expect(backend.updatePassword('longenough')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(auth.updateCalls).toBe(0);
  });

  it('uses the hour copy only for the email-send cap', async () => {
    const auth = authState();
    const backend = openBackend();
    async function copyFor(error: { message: string; status: number; code?: string }) {
      auth.resetError = error;
      try {
        await backend.requestPasswordReset('person@simmer.invalid');
      } catch (e) {
        return errorCopy(e);
      }
      throw new Error('expected requestPasswordReset to fail');
    }

    const byCode = await copyFor({ message: 'over the cap', status: 429, code: 'over_email_send_rate_limit' });
    expect(byCode.body).toBe(PASSWORD_RESET_EMAIL_LIMIT_COPY);
    const byMessage = await copyFor({ message: 'Email rate limit exceeded', status: 429 });
    expect(byMessage.body).toBe(PASSWORD_RESET_EMAIL_LIMIT_COPY);
    const other = await copyFor({ message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' });
    expect(other.body).toMatch(/Wait a minute/);
  });
});
