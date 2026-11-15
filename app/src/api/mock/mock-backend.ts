/**
 * In-memory fake backend for EXPO_PUBLIC_MOCK_MODE. No network, fake data only.
 *
 * - "Sign up" with any email creates a fresh user who goes through onboarding.
 * - "Sign in" with any email/password lands on the demo user (Jordan, 3 of 10
 *   done, 239 XP) so the Today screen has something to show.
 * - Check-ins advance the path and award XP like the server does.
 * State resets when the app reloads.
 */
import type { MockXpStatus } from '../config';
import type { AppSession, Backend } from '../backend';
import { ApiError } from '../errors';
import {
  CheckInInputSchema,
  ProfileInputSchema,
  type CheckInBadge,
  type CheckInResponse,
  type Profile,
  type ProfileInput,
  type RecipeResponse,
} from '../schemas';
import { DEMO_USER, MOCK_CHECK_IN_REPLIES, MOCK_COACH_NOTES, RECIPES, SLOTS, VIDEOS } from './fixtures';
import { awardXp, derivePlan, deriveSummary } from './mock-plan';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake but RFC-valid v4 UUID per slot, so it passes the check-in schema. */
export const mockUserRecipeId = (slotId: number) => `00000000-0000-4000-8000-${String(slotId).padStart(12, '0')}`;

interface MockState {
  session: AppSession | null;
  profile: Profile | null;
  completions: Record<number, number>;
  recipeSlots: Set<number>;
  totalXp: number;
  repeatXpThisWeek: number;
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
    recipeSlots: new Set(),
    totalXp: 0,
    repeatXpThisWeek: 0,
  };

  function setSession(s: AppSession | null) {
    state.session = s;
    listeners.forEach((l) => l(s));
  }

  function loadDemoUser() {
    state.profile = {
      id: 'mock-user-demo',
      goals: 'Cook 3 dinners a week; Spend less on takeout',
      experience_level: 'a_little',
      equipment: ['stove', 'oven', 'pan', 'pot', 'knife', 'cutting board'],
      budget: 'low',
      days_per_week: 3,
      minutes_per_session: 30,
      onboarding_completed: true,
    };
    state.completions = {};
    state.recipeSlots = new Set();
    state.totalXp = 0;
    for (const s of SLOTS.slice(0, DEMO_USER.completedSlots)) {
      state.completions[s.slot_id] = 1;
      state.recipeSlots.add(s.slot_id);
      state.totalXp += s.xp_value;
    }
    return {
      userId: 'mock-user-demo',
      email: DEMO_USER.email,
      firstName: DEMO_USER.firstName,
      accessToken: 'mock-access-token',
    } satisfies AppSession;
  }

  if (opts.startSignedIn) state.session = loadDemoUser();

  function requireSession(): AppSession {
    if (!state.session) throw new ApiError('unauthorized', 'Not signed in.', 401);
    return state.session;
  }

  function currentPlan() {
    return derivePlan(SLOTS, state.completions, state.recipeSlots);
  }

  function badgesFor(slotId: number, firstCompletion: boolean): CheckInBadge[] {
    if (!firstCompletion) return [];
    const slot = SLOTS.find((s) => s.slot_id === slotId);
    if (!slot) return [];
    const earned: CheckInBadge[] = [
      { code: `complete_slot_${slot.slot_order}`, name: slot.dish_name, description: `Cooked ${slot.dish_name} and checked in.`, kind: 'completion' },
    ];
    if (slot.is_final) {
      earned.push({ code: 'mastery', name: 'Roast Chicken Mastery', description: 'Finished the mastery challenge.', kind: 'mastery' });
    }
    if (currentPlan().every((p) => p.status === 'done')) {
      earned.push({ code: 'path_weeknight_basics', name: 'Weeknight Basics Graduate', description: 'Finished every dish on the path.', kind: 'path_milestone' });
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
      setSession(loadDemoUser());
    },

    async signUp(email, _password, firstName) {
      await delay(500);
      if (!email.includes('@')) throw new ApiError('validation', 'Enter a valid email address.', 400);
      state.profile = null;
      state.completions = {};
      state.recipeSlots = new Set();
      state.totalXp = 0;
      state.repeatXpThisWeek = 0;
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
      state.profile = { id: userId, ...row, onboarding_completed: true };
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
      const base = RECIPES[slotId];
      const coachNote = MOCK_COACH_NOTES[slotId];
      return { recipe: coachNote ? { ...base, coachNote } : base, cached, videos: VIDEOS[slotId] ?? {} };
    },

    async getUserRecipeId(slotId) {
      await delay(150);
      requireSession();
      if (!opts.skipGating && !state.recipeSlots.has(slotId)) throw new ApiError('not_found', 'No saved recipe for this slot yet. Open the recipe first.');
      return mockUserRecipeId(slotId);
    },

    async submitCheckIn(input): Promise<CheckInResponse> {
      await delay(900);
      requireSession();
      const body = CheckInInputSchema.parse(input);
      if (body.user_recipe_id !== mockUserRecipeId(body.slot_id) || (!opts.skipGating && !state.recipeSlots.has(body.slot_id))) {
        throw new ApiError('invalid_recipe', 'Invalid user_recipe_id or slot_id mismatch', 400, 'INVALID_RECIPE');
      }
      const slot = SLOTS.find((s) => s.slot_id === body.slot_id);
      if (!slot) throw new ApiError('invalid_recipe', 'Unknown slot', 400, 'INVALID_RECIPE');

      const first = (state.completions[slot.slot_id] ?? 0) === 0;
      state.completions[slot.slot_id] = (state.completions[slot.slot_id] ?? 0) + 1;

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
      return {
        check_in_id: `mock-check-in-${Date.now()}`,
        coach_note: reply.note,
        focus_area: reply.focus,
        xp,
        badges: { status: 'ok', earned: badgesFor(slot.slot_id, first) },
        suggest_repeat: body.rating === 'hard',
      };
    },
  };
}
