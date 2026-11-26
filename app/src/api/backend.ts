/**
 * The one interface screens talk to. Two implementations:
 * - live (`live-backend.ts`): Supabase (anon key + user session) + ai-server
 * - mock (`mock/mock-backend.ts`): in-memory fake data, no network
 *
 * Screens never import supabase-js or fetch directly; they call these methods
 * through `useBackend()`.
 */
import type {
  Badge,
  CheckInHistoryEntry,
  CheckInInput,
  CheckInResponse,
  PersonalizedPath,
  PlanSlot,
  PlanSummary,
  Profile,
  ProfileInput,
  RecipeBookEntry,
  RecipeResponse,
  CookAnythingResponse,
  DishPhoto,
  MasteryRevealResponse,
  MasteryStartResponse,
} from './schemas';
import type { AuthChange } from '../domain/password-reset';

export type { AuthChange };

export interface AppSession {
  userId: string;
  email: string | null;
  /** From auth user_metadata.first_name (set at sign-up). profiles has no name column. */
  firstName: string | null;
  accessToken: string;
}

export interface SignUpResult {
  /** false when the project requires email confirmation before first sign-in. */
  signedIn: boolean;
}

/** Which book entry's check-ins to read. */
export type BookTarget = { kind: 'path'; slotId: number } | { kind: 'cook_anything'; generatedRecipeId: string };

export interface Backend {
  readonly label: 'live' | 'mock' | 'mock-ai';

  // Auth (F1)
  getSession(): Promise<AppSession | null>;
  /** Calls `listener` on sign-in, sign-out and token refresh. Returns unsubscribe. */
  onSessionChange(listener: (session: AppSession | null, change: AuthChange) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, firstName: string): Promise<SignUpResult>;
  signOut(): Promise<void>;
  /**
   * Emails a reset link. Live mode calls Supabase. Full mock mode does not
   * send mail and does not create a session.
   */
  requestPasswordReset(email: string): Promise<void>;
  /** Sets a new password on the current recovery session. */
  updatePassword(password: string): Promise<void>;
  /** Loads a saved recovery and any link the app was opened with. Call before the first route. */
  prepareAuth(): Promise<void>;
  /** True when this signed-in user still has to choose a password. */
  passwordRecoveryPending(): boolean;
  /** True when the latest reset link failed. Do not update whatever session is already on the device. */
  passwordRecoveryFailed(): boolean;
  /** True when `userId` is the account the reset link belongs to. */
  passwordResetOwns(userId: string | null): boolean;
  /** Clears the recovery flag after the new password is saved, or the user leaves. */
  clearPasswordRecovery(): void;
  /** Drops a failed-link flag without signing out a different account. */
  clearRecoveryFailure(): void;

  // Profile / onboarding (F1). RLS: own row only.
  getProfile(userId: string): Promise<Profile | null>;
  /**
   * `tasteSaved` is false when the user gave taste answers but the database
   * doesn't have those columns yet (older deploy), so they weren't stored.
   */
  saveOnboarding(userId: string, input: ProfileInput): Promise<{ tasteSaved: boolean }>;

  /**
   * Re-picks dishes for slots the user hasn't started, from their cuisines,
   * meal types and dietary needs. Call after saveOnboarding. Callers treat a
   * failure as non-fatal (the canonical dishes still show).
   */
  personalizeMyPath(): Promise<PersonalizedPath>;

  // Plan (F2, F7)
  getPlan(): Promise<PlanSlot[]>;
  getPlanSummary(): Promise<PlanSummary>;

  // Badges (F9) and recipe book (F10)
  getBadges(): Promise<Badge[]>;
  getRecipeBook(): Promise<RecipeBookEntry[]>;
  /** The user's own check-ins on one book entry, newest first (RLS: own rows only). */
  getCheckInHistory(target: BookTarget): Promise<CheckInHistoryEntry[]>;

  // AI server (F3-F7, F9)
  generateRecipe(slotId: number, accessToken: string): Promise<RecipeResponse>;
  /** `user_recipes.id` for this user + slot, needed by the check-in. */
  getUserRecipeId(slotId: number): Promise<string>;
  submitCheckIn(input: CheckInInput, accessToken: string): Promise<CheckInResponse>;

  /** F8: start (or resume) the server-side mastery session for the final slot. */
  startMastery(slotId: number, accessToken: string): Promise<MasteryStartResponse>;
  /** F8: reveal one hidden step. The server records it before sending the text. */
  revealMasteryStep(sessionId: string, stepIndex: number, accessToken: string): Promise<MasteryRevealResponse>;

  /** Cook anything: type a dish, get a generated recipe (cached per normalized name). */
  cookAnything(dish: string, accessToken: string): Promise<CookAnythingResponse>;
  getGeneratedRecipe(id: string): Promise<CookAnythingResponse>;
  /** Commons photos keyed by normalized dish name. Missing or failed names are null. */
  dishPhotos(names: string[], accessToken: string): Promise<Record<string, DishPhoto | null>>;
}
