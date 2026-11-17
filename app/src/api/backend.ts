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
  CheckInInput,
  CheckInResponse,
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

export interface Backend {
  readonly label: 'live' | 'mock' | 'mock-ai';

  // Auth (F1)
  getSession(): Promise<AppSession | null>;
  /** Calls `listener` on sign-in, sign-out and token refresh. Returns unsubscribe. */
  onSessionChange(listener: (session: AppSession | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, firstName: string): Promise<SignUpResult>;
  signOut(): Promise<void>;

  // Profile / onboarding (F1). RLS: own row only.
  getProfile(userId: string): Promise<Profile | null>;
  saveOnboarding(userId: string, input: ProfileInput): Promise<void>;

  // Plan (F2, F7)
  getPlan(): Promise<PlanSlot[]>;
  getPlanSummary(): Promise<PlanSummary>;

  // Badges (F9) and recipe book (F10)
  getBadges(): Promise<Badge[]>;
  getRecipeBook(): Promise<RecipeBookEntry[]>;

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
