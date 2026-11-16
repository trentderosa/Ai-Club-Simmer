/**
 * In-memory fake backend for EXPO_PUBLIC_MOCK_MODE. No network, fake data only.
 *
 * - "Sign up" with any email creates a fresh user who goes through onboarding.
 * - "Sign in" with most emails lands on the demo user (Jordan, 3 of 10
 *   done, 239 XP) so the Today screen has something to show.
 * - "Sign in" with mastery@simmer.test lands on a second canned user (Riley,
 *   9 of 10 done, slot 10 current) so the mastery challenge is reachable.
 * - Check-ins advance the path and award XP like the server does.
 * State resets when the app reloads.
 */
import type { MockXpStatus } from '../config';
import type { AppSession, Backend } from '../backend';
import { ApiError } from '../errors';
import {
  CheckInInputSchema,
  ProfileInputSchema,
  type Badge,
  type CheckInBadge,
  type CheckInResponse,
  type Profile,
  type ProfileInput,
  type RecipeBookEntry,
  type RecipeResponse,
  type CookAnythingResponse,
  type MasteryRevealResponse,
  type MasteryStartResponse,
} from '../schemas';
import {
  BADGES,
  CANNED_COOK_ANYTHING_COUNTS,
  CANNED_COOK_ANYTHING_VIDEOS,
  CANNED_COOK_ANYTHING_XP,
  cannedCookAnythingRecipe,
  DEMO_USER,
  MASTERY_USER,
  MOCK_CHECK_IN_REPLIES,
  MOCK_COACH_NOTES,
  RECIPES,
  SLOTS,
  VIDEOS,
} from './fixtures';
import { normalizeDishName, trimDishQuery, clientDishError } from '../../domain/dish-name';
import { hiddenStepIndices, maskRecipeForMastery, qualifiesForMasteryBadge } from '../../domain/mastery';
import { awardXp, derivePlan, deriveSummary } from './mock-plan';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake but RFC-valid v4 UUID per slot, so it passes the check-in schema. */
export const mockUserRecipeId = (slotId: number) => `00000000-0000-4000-8000-${String(slotId).padStart(12, '0')}`;

/** Look up a celebration seal from the shared BADGES catalog. Missing codes fail loudly. */
export function catalogBadge(code: string): CheckInBadge {
  const badge = BADGES.find((b) => b.code === code);
  if (!badge) {
    throw new Error(`Unknown badge code in mock catalog: ${code}`);
  }
  return { code: badge.code, name: badge.name, description: badge.description, kind: badge.kind };
}

interface MockState {
  session: AppSession | null;
  profile: Profile | null;
  completions: Record<number, number>;
  firstCompletedAt: Record<number, string>;
  recipeSlots: Set<number>;
  totalXp: number;
  repeatXpThisWeek: number;
  checkInsByKey: Map<string, CheckInResponse>;
  generatedByName: Map<string, CookAnythingResponse>;
  generatedCompletions: Set<string>;
  masteryEarnedAt: string | null;
  /** F8 server-side mastery sessions, like the mastery_sessions table. */
  masterySessions: Map<string, MockMasterySession>;
}

interface MockMasterySession {
  id: string;
  slotId: number;
  hidden: number[];
  revealed: Set<number>;
  used: boolean;
}

export interface MockOptions {
  xpStatus?: MockXpStatus;
  /** Multiplier for fake latency (0 in tests). */
  latency?: number;
  /** Start signed in as the demo user (used by tests and screenshots). */
  startSignedIn?: boolean;
  /**
   * Skip the mock's own lock/onboarding checks. Used in `ai` mode, where the
   * real Supabase plan (not the mock's) decides what the user can open.
   */
  skipGating?: boolean;
}

export function createMockBackend(opts: MockOptions = {}): Backend {
  const latency = opts.latency ?? 1;
  const delay = (ms: number) => wait(ms * latency);
  const listeners = new Set<(s: AppSession | null) => void>();

  const state: MockState = {
    session: null,
    profile: null,
    completions: {},
    firstCompletedAt: {},
    recipeSlots: new Set(),
    totalXp: 0,
    repeatXpThisWeek: 0,
    checkInsByKey: new Map(),
    generatedByName: new Map(),
    generatedCompletions: new Set(),
    masteryEarnedAt: null,
    masterySessions: new Map(),
  };

  function setSession(s: AppSession | null) {
    state.session = s;
    listeners.forEach((l) => l(s));
  }

  function loadCannedUser(
    user: typeof DEMO_USER | typeof MASTERY_USER,
    userId: string,
  ): AppSession {
    state.profile = {
      id: userId,
      goals: 'Cook 3 dinners a week; Spend less on takeout',
      experience_level: 'a_little',
      equipment: ['stove', 'oven', 'pan', 'pot', 'knife', 'cutting board'],
      budget: 'low',
      days_per_week: 3,
      minutes_per_session: 30,
      onboarding_completed: true,
      created_at: user.createdAt,
    };
    state.completions = {};
    state.firstCompletedAt = {};
    state.recipeSlots = new Set();
    state.totalXp = 0;
    state.repeatXpThisWeek = 0;
    state.checkInsByKey = new Map();
    state.generatedByName = new Map();
    state.generatedCompletions = new Set();
    state.masteryEarnedAt = null;
    state.masterySessions = new Map();
    for (const s of SLOTS.slice(0, user.completedSlots)) {
      const extra = user.extraCooks[s.slot_id] ?? 0;
      state.completions[s.slot_id] = 1 + extra;
      state.recipeSlots.add(s.slot_id);
      state.totalXp += s.xp_value;
      const added = user.addedAt[s.slot_id];
      if (added) state.firstCompletedAt[s.slot_id] = added;
    }
    return {
      userId,
      email: user.email,
      firstName: user.firstName,
      accessToken: 'mock-access-token',
    } satisfies AppSession;
  }

  function loadDemoUser() {
    return loadCannedUser(DEMO_USER, 'mock-user-demo');
  }

  function loadMasteryUser() {
    return loadCannedUser(MASTERY_USER, 'mock-user-mastery');
  }

  if (opts.startSignedIn) state.session = loadDemoUser();

  function requireSession(): AppSession {
    if (!state.session) throw new ApiError('unauthorized', 'Not signed in.', 401);
    return state.session;
  }

  function currentPlan() {
    return derivePlan(SLOTS, state.completions, state.recipeSlots);
  }

  function badgesFor(
    slotId: number,
    firstCompletion: boolean,
    mastery: { hidden_steps: number; revealed_steps: number } | undefined,
  ): CheckInBadge[] {
    const slot = SLOTS.find((s) => s.slot_id === slotId);
    if (!slot) return [];
    const earned: CheckInBadge[] = [];
    // Completion badges exist only for slots 1–9. Slot 10 is the mastery
    // challenge, so a final-slot check-in must not invent complete_slot_10.
    if (firstCompletion && !slot.is_final) {
      earned.push(catalogBadge(`complete_slot_${slot.slot_order}`));
    }
    // Mastery badge: only on a final-slot check-in with revealed_steps = 0.
    // A missing payload earns no badge. Repeats can still earn it later.
    // Record mastery as earned only after the catalog lookup succeeds.
    if (slot.is_final && qualifiesForMasteryBadge(mastery) && !state.masteryEarnedAt) {
      const masteryBadge = catalogBadge('mastery');
      state.masteryEarnedAt = new Date().toISOString();
      earned.push(masteryBadge);
    }
    if (firstCompletion && currentPlan().every((p) => p.status === 'done')) {
      earned.push(catalogBadge('path_weeknight_basics'));
    }
    return earned;
  }

  return {
    label: 'mock',

    async getSession() {
      return state.session;
    },

    onSessionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async signIn(email) {
      await delay(400);
      if (!email.includes('@')) throw new ApiError('unauthorized', 'Invalid login credentials', 400);
      const canned =
        email.trim().toLowerCase() === MASTERY_USER.email ? loadMasteryUser() : loadDemoUser();
      setSession(canned);
    },

    async signUp(email, _password, firstName) {
      await delay(500);
      if (!email.includes('@')) throw new ApiError('validation', 'Enter a valid email address.', 400);
      state.profile = null;
      state.completions = {};
      state.firstCompletedAt = {};
      state.recipeSlots = new Set();
      state.totalXp = 0;
      state.repeatXpThisWeek = 0;
      state.checkInsByKey = new Map();
      state.generatedByName = new Map();
      state.generatedCompletions = new Set();
      state.masteryEarnedAt = null;
      state.masterySessions = new Map();
      setSession({ userId: 'mock-user-new', email, firstName: firstName.trim() || null, accessToken: 'mock-access-token' });
      return { signedIn: true };
    },

    async signOut() {
      setSession(null);
    },

    async getProfile(userId) {
      await delay(250);
      requireSession();
      return state.profile && state.profile.id === userId ? state.profile : null;
    },

    async saveOnboarding(userId, input: ProfileInput) {
      await delay(500);
      requireSession();
      const row = ProfileInputSchema.parse(input);
      state.profile = {
        id: userId,
        ...row,
        onboarding_completed: true,
        created_at: state.profile?.created_at ?? new Date().toISOString(),
      };
    },

    async getPlan() {
      await delay(450);
      requireSession();
      return currentPlan();
    },

    async getPlanSummary() {
      await delay(300);
      requireSession();
      const p = state.profile;
      const schedule = p?.days_per_week && p.minutes_per_session ? { days_per_week: p.days_per_week, minutes_per_session: p.minutes_per_session } : null;
      return deriveSummary(currentPlan(), SLOTS, state.totalXp, schedule);
    },

    async getBadges() {
      await delay(300);
      requireSession();
      return deriveMockBadges(state.completions, state.firstCompletedAt, state.masteryEarnedAt);
    },

    async getRecipeBook() {
      await delay(350);
      requireSession();
      return deriveMockRecipeBook(state.completions, state.firstCompletedAt, state.recipeSlots);
    },

    async generateRecipe(slotId): Promise<RecipeResponse> {
      requireSession();
      const cached = state.recipeSlots.has(slotId);
      await delay(cached ? 200 : 1400);
      const slot = currentPlan().find((s) => s.slot_id === slotId);
      if (!slot) throw new ApiError('not_found', `Path slot ${slotId} not found`, 404);
      if (!opts.skipGating && !cached && slot.status === 'locked') {
        throw new ApiError('slot_locked', 'This recipe is locked. Finish the earlier recipes on your path first.', 403, 'SLOT_LOCKED');
      }
      if (!opts.skipGating && !state.profile?.onboarding_completed) {
        throw new ApiError('onboarding_required', 'User profile not found. Please complete onboarding first.', 404);
      }
      state.recipeSlots.add(slotId);
      const base = slot.is_final ? maskRecipeForMastery(RECIPES[slotId]) : RECIPES[slotId];
      const coachNote = MOCK_COACH_NOTES[slotId];
      return { recipe: coachNote ? { ...base, coachNote } : base, cached, videos: VIDEOS[slotId] ?? {} };
    },

    async startMastery(slotId): Promise<MasteryStartResponse> {
      await delay(250);
      requireSession();
      const slot = SLOTS.find((s) => s.slot_id === slotId);
      if (!slot?.is_final) {
        throw new ApiError('validation', 'Only the final recipe on the path is a mastery challenge.', 400, 'SLOT_NOT_FINAL');
      }
      if (!opts.skipGating && !state.recipeSlots.has(slotId)) {
        throw new ApiError('not_found', 'Open the recipe first so it can be written for you.', 404, 'RECIPE_NOT_FOUND');
      }
      let session = [...state.masterySessions.values()].find((m) => m.slotId === slotId && !m.used);
      if (!session) {
        session = {
          id: `20000000-0000-4000-8000-${String(state.masterySessions.size + 1).padStart(12, '0')}`,
          slotId,
          hidden: hiddenStepIndices(RECIPES[slotId].steps),
          revealed: new Set(),
          used: false,
        };
        state.masterySessions.set(session.id, session);
      }
      const revealed_steps: MasteryStartResponse['revealed_steps'] = {};
      for (const i of session.revealed) revealed_steps[String(i)] = RECIPES[slotId].steps[i];
      return { session_id: session.id, hidden_step_indices: [...session.hidden], revealed_steps };
    },

    async revealMasteryStep(sessionId, stepIndex): Promise<MasteryRevealResponse> {
      await delay(250);
      requireSession();
      const session = state.masterySessions.get(sessionId);
      if (!session) throw new ApiError('not_found', 'Mastery session not found.', 404, 'MASTERY_SESSION_NOT_FOUND');
      if (session.used) {
        throw new ApiError('mastery_session_used', 'This mastery session is already checked in.', 409, 'MASTERY_SESSION_USED');
      }
      if (!session.hidden.includes(stepIndex)) {
        throw new ApiError('validation', 'That step is not hidden in this challenge.', 400, 'STEP_NOT_HIDDEN');
      }
      session.revealed.add(stepIndex);
      return {
        step_index: stepIndex,
        step: RECIPES[session.slotId].steps[stepIndex],
        hidden_step_indices: [...session.hidden],
        revealed_step_indices: [...session.revealed].sort((a, b) => a - b),
      };
    },

    async getUserRecipeId(slotId) {
      await delay(150);
      requireSession();
      if (!opts.skipGating && !state.recipeSlots.has(slotId)) throw new ApiError('not_found', 'No saved recipe for this slot yet. Open the recipe first.');
      return mockUserRecipeId(slotId);
    },

    async cookAnything(dish): Promise<CookAnythingResponse> {
      requireSession();
      const error = clientDishError(dish);
      if (error) throw new ApiError('validation', error, 400, 'INVALID_DISH');
      const dishQuery = trimDishQuery(dish);
      const normalized = normalizeDishName(dishQuery);
      const existing = state.generatedByName.get(normalized);
      if (existing) {
        await delay(200);
        return { ...existing, cached: true };
      }
      await delay(1400);
      if (!opts.skipGating && !state.profile?.onboarding_completed) {
        throw new ApiError('onboarding_required', 'User profile not found. Please complete onboarding first.', 404);
      }
      const pretty = dishQuery
        .split(' ')
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ');
      const id = `10000000-0000-4000-8000-${String(state.generatedByName.size + 1).padStart(12, '0')}`;
      const response: CookAnythingResponse = {
        generated_recipe_id: id,
        dish_query: dishQuery,
        normalized_dish_name: normalized,
        recipe: cannedCookAnythingRecipe(pretty),
        cached: false,
        videos: CANNED_COOK_ANYTHING_VIDEOS,
        xp_value: CANNED_COOK_ANYTHING_XP,
        counts: { ...CANNED_COOK_ANYTHING_COUNTS },
      };
      state.generatedByName.set(normalized, response);
      return response;
    },

    async getGeneratedRecipe(id) {
      await delay(150);
      requireSession();
      for (const saved of state.generatedByName.values()) {
        if (saved.generated_recipe_id === id) return { ...saved, cached: true };
      }
      throw new ApiError('not_found', 'No saved recipe for that dish yet.');
    },

    async submitCheckIn(input): Promise<CheckInResponse> {
      await delay(900);
      requireSession();
      const body = CheckInInputSchema.parse(input);
      if (body.idempotency_key) {
        const existing = state.checkInsByKey.get(body.idempotency_key);
        if (existing) return existing;
      }
      if (body.generated_recipe_id) {
        if (body.mastery_session_id) {
          throw new ApiError(
            'validation',
            'mastery is only allowed for the final (mastery challenge) recipe',
            400,
            'MASTERY_NOT_ALLOWED',
          );
        }
        let found: CookAnythingResponse | undefined;
        for (const saved of state.generatedByName.values()) {
          if (saved.generated_recipe_id === body.generated_recipe_id) found = saved;
        }
        if (!found) throw new ApiError('invalid_recipe', 'Invalid generated_recipe_id', 400, 'INVALID_RECIPE');
        const first = !state.generatedCompletions.has(found.normalized_dish_name);
        if (first) state.generatedCompletions.add(found.normalized_dish_name);
        let xp: CheckInResponse['xp'];
        const xpStatus = opts.xpStatus ?? 'awarded';
        if (xpStatus === 'awarded') {
          const amount = first ? found.xp_value : Math.floor((found.xp_value * 50) / 100);
          state.totalXp += amount;
          if (!first) state.repeatXpThisWeek += amount;
          xp = { status: 'awarded', xp_awarded: amount, is_first_completion: first, capped: false };
        } else {
          xp = { status: xpStatus };
        }
        const reply = MOCK_CHECK_IN_REPLIES[body.rating];
        const response: CheckInResponse = {
          check_in_id: body.idempotency_key ?? `mock-check-in-${Date.now()}`,
          coach_note: reply.note,
          focus_area: reply.focus,
          xp,
          badges: { status: 'ok', earned: [] },
          suggest_repeat: body.rating === 'hard',
        };
        if (body.idempotency_key) state.checkInsByKey.set(body.idempotency_key, response);
        return response;
      }
      if (!body.slot_id || !body.user_recipe_id || body.user_recipe_id !== mockUserRecipeId(body.slot_id) || (!opts.skipGating && !state.recipeSlots.has(body.slot_id))) {
        throw new ApiError('invalid_recipe', 'Invalid user_recipe_id or slot_id mismatch', 400, 'INVALID_RECIPE');
      }
      const slot = SLOTS.find((s) => s.slot_id === body.slot_id);
      if (!slot) throw new ApiError('invalid_recipe', 'Unknown slot', 400, 'INVALID_RECIPE');
      if (body.mastery_session_id && !slot.is_final) {
        throw new ApiError(
          'validation',
          'mastery is only allowed for the final (mastery challenge) recipe',
          400,
          'MASTERY_NOT_ALLOWED',
        );
      }
      // Like the database: counts come from the session, and a session backs one check-in.
      let mastery: { hidden_steps: number; revealed_steps: number } | undefined;
      if (body.mastery_session_id) {
        const session = state.masterySessions.get(body.mastery_session_id);
        if (!session || session.slotId !== slot.slot_id) {
          throw new ApiError('validation', 'mastery_session_id does not match this check-in', 400, 'INVALID_MASTERY_SESSION');
        }
        if (session.used) {
          throw new ApiError('mastery_session_used', 'This mastery session was already used for a check-in', 409, 'MASTERY_SESSION_USED');
        }
        session.used = true;
        mastery = { hidden_steps: session.hidden.length, revealed_steps: session.revealed.size };
      }

      const first = (state.completions[slot.slot_id] ?? 0) === 0;
      state.completions[slot.slot_id] = (state.completions[slot.slot_id] ?? 0) + 1;
      if (first && !state.firstCompletedAt[slot.slot_id]) {
        state.firstCompletedAt[slot.slot_id] = new Date().toISOString();
      }

      let xp: CheckInResponse['xp'];
      const xpStatus = opts.xpStatus ?? 'awarded';
      if (xpStatus === 'awarded') {
        const award = awardXp(slot.xp_value, first, state.repeatXpThisWeek);
        state.totalXp += award.xp_awarded;
        if (!first) state.repeatXpThisWeek += award.xp_awarded;
        xp = { status: 'awarded', xp_awarded: award.xp_awarded, is_first_completion: first, capped: award.capped };
      } else {
        xp = { status: xpStatus };
      }

      const reply = MOCK_CHECK_IN_REPLIES[body.rating];
      const response: CheckInResponse = {
        check_in_id: body.idempotency_key ?? `mock-check-in-${Date.now()}`,
        coach_note: reply.note,
        focus_area: reply.focus,
        xp,
        badges: { status: 'ok', earned: badgesFor(slot.slot_id, first, mastery) },
        suggest_repeat: body.rating === 'hard',
      };
      if (body.idempotency_key) state.checkInsByKey.set(body.idempotency_key, response);
      return response;
    },
  };
}

export function deriveMockBadges(
  completions: Record<number, number>,
  firstCompletedAt: Record<number, string>,
  masteryEarnedAt: string | null = null,
): Badge[] {
  const pathComplete = SLOTS.every((s) => (completions[s.slot_id] ?? 0) > 0);
  const lastAt = pathComplete
    ? SLOTS.reduce((latest, s) => {
        const at = firstCompletedAt[s.slot_id];
        return at && (!latest || at > latest) ? at : latest;
      }, null as string | null)
    : null;
  return BADGES.map((b) => {
    const earned =
      b.kind === 'path_milestone'
        ? pathComplete
        : b.kind === 'mastery'
          ? masteryEarnedAt != null
          : b.slot_id != null && (completions[b.slot_id] ?? 0) > 0;
    const earned_at =
      b.kind === 'path_milestone' ? lastAt : b.kind === 'mastery' ? masteryEarnedAt : b.slot_id != null ? (firstCompletedAt[b.slot_id] ?? null) : null;
    return { ...b, earned, earned_at: earned ? earned_at : null };
  });
}

export function deriveMockRecipeBook(
  completions: Record<number, number>,
  firstCompletedAt: Record<number, string>,
  recipeSlots: Set<number>,
): RecipeBookEntry[] {
  return SLOTS.filter((s) => (completions[s.slot_id] ?? 0) > 0).map((s) => ({
    slot_id: s.slot_id,
    slot_order: s.slot_order,
    dish_name: s.dish_name,
    user_recipe_id: recipeSlots.has(s.slot_id) ? mockUserRecipeId(s.slot_id) : null,
    recipe_title: RECIPES[s.slot_id]?.title ?? s.dish_name,
    label: s.is_final ? 'mastered' : 'completed',
    added_at: firstCompletedAt[s.slot_id] ?? null,
    times_cooked: completions[s.slot_id],
  }));
}
