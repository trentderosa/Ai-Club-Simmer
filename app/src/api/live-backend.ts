import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import type { z } from 'zod';

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
  const supabase: SupabaseClient = createSupabaseClient(opts.supabaseUrl, opts.supabaseAnonKey);
  const ai = typeof opts.ai === 'string' ? createAiServerClient(opts.ai) : opts.ai;

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
      const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(toAppSession(session)));
      return () => data.subscription.unsubscribe();
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
