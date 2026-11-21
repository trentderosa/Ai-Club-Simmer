import type { Session, SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { AppState, Platform } from 'react-native';
import type { z } from 'zod';

import {
  authCallbackUrlWithoutSecrets,
  authRedirectTo,
  mapAuthChange,
  PASSWORD_RESET_EMAIL_LIMIT_COPY,
  parseRecoveryLink,
  readRecoveryOwner,
  recoverySessionMatchesLink,
  resolveWebBasePath,
  writeRecoveryOwner,
  type AuthChange,
  type RecoveryLink,
} from '../domain/password-reset';
import { createAiServerClient, type AiServerClient } from './ai-server';
import type { AppSession, Backend } from './backend';
import { ApiError } from './errors';
import {
  BadgesSchema,
  CheckInHistorySchema,
  PlanSchema,
  PlanSummaryRowsSchema,
  ProfileInputSchema,
  ProfileSchema,
  CookAnythingResponseSchema,
  parseStoredDishPhoto,
  RecipeBookSchema,
  RecipeSchema,
  VideosSchema,
} from './schemas';
import { rpcRecipeBook } from './recipe-book-rpc';
import { createSupabaseClient } from './supabase';

export function toAppSession(session: Session | null): AppSession | null {
  if (!session) return null;
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  const firstName = typeof meta.first_name === 'string' && meta.first_name.trim() ? meta.first_name.trim() : null;
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    firstName,
    accessToken: session.access_token,
  };
}

/** Supabase/PostgREST error -> ApiError. JWT problems become `unauthorized`. */
function fromSupabaseError(e: { message: string; code?: string; status?: number }): ApiError {
  const msg = e.message || 'Supabase request failed.';
  if (e.status === 401 || e.code === 'PGRST301' || /jwt|authentication required/i.test(msg)) {
    return new ApiError('unauthorized', msg, e.status, e.code);
  }
  if (/failed to fetch|network/i.test(msg)) return new ApiError('network', `Can't reach Supabase. ${msg}`);
  return new ApiError('server', msg, e.status, e.code);
}

/** The auth service's hourly email cap. Other 429s are a short cooldown. */
function isEmailSendCap(error: { message?: string; code?: string }): boolean {
  if (error.code === 'over_email_send_rate_limit') return true;
  return /email rate limit|over_email_send_rate_limit/i.test(error.message ?? '');
}

function fromAuthError(e: { message: string; status?: number; code?: string }): ApiError {
  const msg = e.message || 'Supabase auth request failed.';
  if (e.status === 429 || /rate limit/i.test(msg)) return new ApiError('rate_limited', msg, e.status, e.code);
  if (e.status === 400 || e.status === 422) return new ApiError('validation', msg, e.status, e.code);
  if (e.status === 401) return new ApiError('unauthorized', msg, e.status, e.code);
  if (/failed to fetch|network/i.test(msg)) return new ApiError('network', `Can't reach Supabase. ${msg}`);
  return new ApiError('server', msg, e.status, e.code);
}

function configuredBasePath(): string | null {
  const experiments = Constants.expoConfig?.experiments as { baseUrl?: unknown } | undefined;
  return typeof experiments?.baseUrl === 'string' ? experiments.baseUrl : null;
}

function documentBaseHref(): string | null {
  try {
    if (typeof document === 'undefined') return null;
    return document.querySelector('base')?.getAttribute('href') ?? null;
  } catch {
    return null;
  }
}

/** Current web origin + Pages base (or the local origin) + /reset-password. Native uses the app scheme. */
function passwordResetRedirect(): string {
  return authRedirectTo({
    platform: Platform.OS,
    href: typeof window === 'undefined' ? null : window.location.href,
    basePath: resolveWebBasePath(configuredBasePath(), documentBaseHref()),
    nativeUrl: Linking.createURL('reset-password'),
  });
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError('bad_response', `Unexpected ${what} from Supabase: ${r.error.message}`);
  return r.data;
}

export function createLiveBackend(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  ai: AiServerClient | string;
  label?: Backend['label'];
}): Backend {
  // Read the callback before the client is created. detectSessionInUrl strips the hash on success.
  const initialLink: RecoveryLink = parseRecoveryLink(typeof window === 'undefined' ? null : window.location.href);
  let recoveryOwnerId: string | null = null;
  let recoveryFailed = false;
  let expectRecovery = false;
  // True until the launch restore has finished, including the queued SIGNED_IN from storage.
  let startup = true;
  const listeners = new Set<(session: AppSession | null, change: AuthChange) => void>();
  let preparing: Promise<void> | null = null;

  const supabase: SupabaseClient = createSupabaseClient(opts.supabaseUrl, opts.supabaseAnonKey);
  const ai = typeof opts.ai === 'string' ? createAiServerClient(opts.ai) : opts.ai;

  function acceptRecovery(userId: string) {
    recoveryOwnerId = userId;
    recoveryFailed = false;
    void writeRecoveryOwner(AsyncStorage, userId);
  }

  function emit(session: AppSession | null, change: AuthChange) {
    listeners.forEach((listener) => listener(session, change));
  }

  // Subscribe before initialization finishes, or the recovery event is missed.
  supabase.auth.onAuthStateChange((event, session) => {
    const appSession = toAppSession(session);
    const userId = session?.user?.id ?? null;
    if (userId && (event === 'PASSWORD_RECOVERY' || (expectRecovery && event === 'SIGNED_IN'))) {
      expectRecovery = false;
      acceptRecovery(userId);
      emit(appSession, 'password_recovery');
      return;
    }
    if (event === 'SIGNED_IN' && !startup && userId !== recoveryOwnerId) {
      // A different user signed in. A same-user SIGNED_IN after startup is a tab refocus.
      recoveryOwnerId = null;
      void writeRecoveryOwner(AsyncStorage, null);
    }
    emit(appSession, mapAuthChange(event));
  });

  async function restoreStoredOwner(stored: string | null) {
    if (!stored || recoveryOwnerId) return;
    const { data } = await supabase.auth.getSession();
    const current = data.session?.user.id ?? null;
    if (current && current === stored) {
      recoveryOwnerId = stored;
      return;
    }
    if (current && current !== stored) await writeRecoveryOwner(AsyncStorage, null);
  }

  async function adoptRecoveryUrl(href: string | null) {
    const link = parseRecoveryLink(href);
    if (link.kind === 'none') return;
    if (link.kind === 'error') {
      recoveryFailed = true;
      let current: AppSession | null = null;
      try {
        const { data } = await supabase.auth.getSession();
        current = toAppSession(data.session);
      } catch {
        current = null;
      }
      emit(current, 'password_recovery_failed');
      return;
    }
    if (link.kind === 'code') {
      const { data, error } = await supabase.auth.exchangeCodeForSession(link.code);
      if (error || !data.session?.user?.id || !recoveryOwnerId) recoveryFailed = true;
      return;
    }
    expectRecovery = true;
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: link.accessToken,
        refresh_token: link.refreshToken,
      });
      if (error || !data.session?.user?.id) recoveryFailed = true;
      else acceptRecovery(data.session.user.id);
    } finally {
      expectRecovery = false;
    }
  }

  function stripBrowserSecrets() {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    try {
      const next = authCallbackUrlWithoutSecrets(window.location.href);
      if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
    } catch {
      // Leave the address bar alone. Tokens are not logged.
    }
  }

  if (Platform.OS !== 'web') {
    Linking.addEventListener('url', ({ url }) => {
      void adoptRecoveryUrl(url);
    });
  }

  // Supabase recommends pausing token refresh while the app is backgrounded.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });

  return {
    label: opts.label ?? 'live',

    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw fromSupabaseError(error);
      return toAppSession(data.session);
    },

    onSessionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new ApiError('unauthorized', error.message, error.status);
    },

    async signUp(email, password, firstName) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { first_name: firstName.trim() } },
      });
      if (error) throw new ApiError('validation', error.message, error.status);
      return { signedIn: data.session !== null };
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw fromSupabaseError(error);
    },

    async requestPasswordReset(email) {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: passwordResetRedirect() });
      if (!error) return;
      // Only the hourly email cap. Another 429 keeps the short cooldown copy.
      if (isEmailSendCap(error)) {
        throw new ApiError('rate_limited', PASSWORD_RESET_EMAIL_LIMIT_COPY, error.status, 'email_rate_limited');
      }
      throw fromAuthError(error);
    },

    async updatePassword(password) {
      if (password.length < 6) throw new ApiError('validation', 'Password should be at least 6 characters.');
      const { data: current } = await supabase.auth.getSession();
      const userId = current.session?.user.id ?? null;
      if (!recoveryOwnerId || userId !== recoveryOwnerId) {
        throw new ApiError('unauthorized', 'That link has expired or was already used.');
      }
      const { data, error } = await supabase.auth.updateUser({ password });
      if (error) throw fromAuthError(error);
      if (!data.user) throw new ApiError('unauthorized', 'That link has expired or was already used.');
    },

    async prepareAuth() {
      if (!preparing) {
        preparing = (async () => {
          try {
            const stored = await readRecoveryOwner(AsyncStorage);
            if (Platform.OS === 'web') {
              const { data } = await supabase.auth.getSession();
              // The session is already the link's tokens. Don't wait on the notify timer to accept it.
              if (recoverySessionMatchesLink(initialLink, data.session?.access_token) && data.session?.user?.id) {
                acceptRecovery(data.session.user.id);
              }
              // PASSWORD_RECOVERY still accepts the session if this comparison missed it.
              await new Promise((resolve) => setTimeout(resolve, 0));
              stripBrowserSecrets();
              const callback = initialLink.kind === 'tokens' || initialLink.kind === 'code';
              if (initialLink.kind === 'error' || (callback && !recoveryOwnerId)) recoveryFailed = true;
              if (!recoveryOwnerId) await restoreStoredOwner(stored);
              return;
            }
            await adoptRecoveryUrl(await Linking.getInitialURL());
            if (!recoveryOwnerId) await restoreStoredOwner(stored);
          } finally {
            // Init can emit SIGNED_IN after getSession returns. That one is the restored session.
            setTimeout(() => {
              startup = false;
            }, 0);
          }
        })();
      }
      return preparing;
    },

    passwordRecoveryPending() {
      return recoveryOwnerId !== null && !recoveryFailed;
    },

    passwordRecoveryFailed() {
      return recoveryFailed;
    },

    passwordResetOwns(userId) {
      return userId !== null && userId === recoveryOwnerId;
    },

    clearPasswordRecovery() {
      recoveryOwnerId = null;
      recoveryFailed = false;
      expectRecovery = false;
      void writeRecoveryOwner(AsyncStorage, null);
    },

    clearRecoveryFailure() {
      recoveryFailed = false;
    },

    async getProfile(userId) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, goals, experience_level, equipment, budget, days_per_week, minutes_per_session, onboarding_completed, created_at')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw fromSupabaseError(error);
      return data ? parseOrThrow(ProfileSchema, data, 'profile') : null;
    },

    async saveOnboarding(userId, input) {
      const row = ProfileInputSchema.parse(input);
      const { error } = await supabase
        .from('profiles')
        .upsert({ id: userId, ...row, onboarding_completed: true });
      if (error) throw fromSupabaseError(error);
    },

    async getPlan() {
      const { data, error } = await supabase.rpc('get_my_plan');
      if (error) throw fromSupabaseError(error);
      return parseOrThrow(PlanSchema, data, 'plan');
    },

    async getPlanSummary() {
      const { data, error } = await supabase.rpc('get_my_plan_summary');
      if (error) throw fromSupabaseError(error);
      return parseOrThrow(PlanSummaryRowsSchema, data, 'plan summary')[0];
    },

    async getBadges() {
      const { data, error } = await supabase.rpc('get_my_badges');
      if (error) throw fromSupabaseError(error);
      return parseOrThrow(BadgesSchema, data, 'badges');
    },

    async getRecipeBook() {
      const { data, error } = await rpcRecipeBook((fn) => supabase.rpc(fn));
      if (error) throw fromSupabaseError(error);
      return parseOrThrow(RecipeBookSchema, data, 'recipe book');
    },

    async getCheckInHistory(target) {
      const columns = 'id, difficulty_rating, went_well, was_hard, created_at';
      // RLS ("own rows only") scopes both tables to the signed-in user.
      const query =
        target.kind === 'path'
          ? supabase.from('check_ins').select(columns).eq('slot_id', target.slotId)
          : supabase.from('generated_recipe_check_ins').select(columns).eq('generated_recipe_id', target.generatedRecipeId);
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(200);
      if (error) throw fromSupabaseError(error);
      return parseOrThrow(CheckInHistorySchema, data, 'check-in history');
    },

    generateRecipe: (slotId, token) => ai.generateRecipe(slotId, token),

    async getUserRecipeId(slotId) {
      const { data, error } = await supabase.from('user_recipes').select('id').eq('slot_id', slotId).maybeSingle();
      if (error) throw fromSupabaseError(error);
      if (!data || typeof data.id !== 'string') {
        throw new ApiError('not_found', 'No saved recipe for this slot yet. Open the recipe first.');
      }
      return data.id;
    },

    submitCheckIn: (input, token) => ai.submitCheckIn(input, token),
    startMastery: (slotId, token) => ai.startMastery(slotId, token),
    revealMasteryStep: (sessionId, stepIndex, token) => ai.revealMasteryStep(sessionId, stepIndex, token),

    cookAnything: (dish, token) => ai.cookAnything(dish, token),
    dishPhotos: (names, token) => ai.dishPhotos(names, token),

    async getGeneratedRecipe(id) {
      const columns =
        'id, dish_query, normalized_dish_name, recipe_json, video_ids, photo_json, step_count, ingredient_count, time_estimate_minutes, xp_value';
      const legacyColumns =
        'id, dish_query, normalized_dish_name, recipe_json, video_ids, step_count, ingredient_count, time_estimate_minutes, xp_value';
      let result = await supabase.from('user_generated_recipes').select(columns).eq('id', id).maybeSingle();
      // photo_json is added by 20261117140000_dish_photos.sql. Until that
      // migration is applied, retry without it and show the board.jpg fallback.
      if (result.error && /photo_json/i.test(result.error.message ?? '')) {
        result = await supabase.from('user_generated_recipes').select(legacyColumns).eq('id', id).maybeSingle();
      }
      const { data, error } = result;
      if (error) throw fromSupabaseError(error);
      if (!data) throw new ApiError('not_found', 'No saved recipe for that dish yet.');
      const recipe = RecipeSchema.safeParse(data.recipe_json);
      if (!recipe.success) throw new ApiError('bad_response', 'Unexpected generated recipe from Supabase.');
      const videos = VideosSchema.parse(data.video_ids ?? {});
      return CookAnythingResponseSchema.parse({
        generated_recipe_id: data.id,
        dish_query: data.dish_query,
        normalized_dish_name: data.normalized_dish_name,
        recipe: recipe.data,
        cached: true,
        videos,
        photo: 'photo_json' in data ? parseStoredDishPhoto(data.photo_json) : null,
        xp_value: data.xp_value,
        counts: {
          steps: data.step_count,
          ingredients: data.ingredient_count,
          minutes: data.time_estimate_minutes,
        },
      });
    },
  };
}
