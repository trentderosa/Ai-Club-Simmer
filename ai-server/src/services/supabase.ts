import { UserProfile } from '../schemas/user.js';
import { Recipe } from '../schemas/recipe.js';
import type { PathSlot } from './recipe-generator.js';
import type { JwtVerifier, JwtVerifyResult } from './jwt-verifier.js';
import type { UserRecipeRepository } from '../repositories/user-recipe-repository.js';
import type { PathRepository } from '../repositories/path-repository.js';
import type { RecipeVideos } from './video-finder.js';

export interface SupabaseService {
  verifyToken(token: string): Promise<JwtVerifyResult>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  getPathSlot(slotId: number, userId: string): Promise<PathSlot | null>;
  /** F2 path order: may this user start this slot (done or current)? */
  isSlotUnlocked(userId: string, slotId: number): Promise<boolean>;
  getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null>;
  saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<Recipe>;
  /** F4: stored technique videos, or null if not looked up yet. */
  getSavedVideos(userId: string, slotId: number): Promise<RecipeVideos | null>;
  saveVideos(userId: string, slotId: number, videos: RecipeVideos): Promise<void>;
}

export interface SupabaseServiceDeps {
  jwtVerifier: JwtVerifier;
  userRecipeRepository: UserRecipeRepository;
  /**
   * Path data (slots, profiles, gating). Without it (dev in-memory mode)
   * slots and profiles are not found and every slot counts as unlocked.
   */
  pathRepository?: PathRepository;
}

export function createSupabaseService(deps: SupabaseServiceDeps): SupabaseService {
  const { jwtVerifier, userRecipeRepository, pathRepository } = deps;

  return {
    verifyToken(token: string): Promise<JwtVerifyResult> {
      return jwtVerifier.verify(token);
    },

    getUserProfile(userId: string): Promise<UserProfile | null> {
      return pathRepository ? pathRepository.getUserProfile(userId) : Promise.resolve(null);
    },

    getPathSlot(slotId: number, userId: string): Promise<PathSlot | null> {
      return pathRepository ? pathRepository.getPathSlot(slotId, userId) : Promise.resolve(null);
    },

    isSlotUnlocked(userId: string, slotId: number): Promise<boolean> {
      return pathRepository ? pathRepository.isSlotUnlocked(userId, slotId) : Promise.resolve(true);
    },

    async getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null> {
      const saved = await userRecipeRepository.findByUserAndSlot(userId, slotId);
      return saved?.recipe ?? null;
    },

    async saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<Recipe> {
      const saved = await userRecipeRepository.save(userId, slotId, recipe);
      return saved.recipe;
    },

    async getSavedVideos(userId: string, slotId: number): Promise<RecipeVideos | null> {
      const saved = await userRecipeRepository.findByUserAndSlot(userId, slotId);
      return saved?.videos ?? null;
    },

    saveVideos(userId: string, slotId: number, videos: RecipeVideos): Promise<void> {
      return userRecipeRepository.saveVideos(userId, slotId, videos);
    },
  };
}

export interface SupabaseStubOptions {
  allowStubAuth?: boolean;
}

/**
 * Creates a stub Supabase service for development/testing.
 *
 * SECURITY: By default, verifyToken FAILS CLOSED (returns { valid: false }).
 * To enable stub auth for local development, set ALLOW_STUB_AUTH=true.
 * This is blocked in production (NODE_ENV=production).
 */
export function createSupabaseStub(
  options: SupabaseStubOptions = {}
): SupabaseService {
  const allowStubAuth = options.allowStubAuth ?? false;

  return {
    verifyToken(_token: string): Promise<JwtVerifyResult> {
      // SECURITY: Stub auth fails closed by default.
      // Only accepts tokens when explicitly enabled via ALLOW_STUB_AUTH=true.
      if (!allowStubAuth) {
        return Promise.resolve({ valid: false, error: 'invalid_token' });
      }

      console.warn(
        'STUB AUTH ENABLED - accepting any token as stub-user-id'
      );
      return Promise.resolve({ valid: true, userId: 'stub-user-id' });
    },

    getUserProfile(_userId: string): Promise<UserProfile | null> {
      return Promise.resolve(null);
    },

    getPathSlot(_slotId: number, _userId: string): Promise<PathSlot | null> {
      return Promise.resolve(null);
    },

    isSlotUnlocked(_userId: string, _slotId: number): Promise<boolean> {
      return Promise.resolve(true);
    },

    getSavedVideos(_userId: string, _slotId: number): Promise<RecipeVideos | null> {
      return Promise.resolve(null);
    },

    saveVideos(_userId: string, _slotId: number, _videos: RecipeVideos): Promise<void> {
      return Promise.resolve();
    },

    getSavedRecipe(_userId: string, _slotId: number): Promise<Recipe | null> {
      return Promise.resolve(null);
    },

    saveRecipe(
      _userId: string,
      _slotId: number,
      recipe: Recipe
    ): Promise<Recipe> {
      return Promise.resolve(recipe);
    },
  };
}

/**
 * Checks if stub auth is allowed based on environment variables.
 * Returns true only if ALLOW_STUB_AUTH=true AND NODE_ENV is not 'production'.
 *
 * SECURITY: This function prevents accidental use of stub auth in production.
 * Even if ALLOW_STUB_AUTH=true is set in production, it will return false
 * and log a security error.
 */
export function isStubAuthAllowed(): boolean {
  const allowStubAuth = process.env.ALLOW_STUB_AUTH === 'true';
  const isProduction = process.env.NODE_ENV === 'production';

  if (allowStubAuth && isProduction) {
    console.error(
      'SECURITY ERROR: ALLOW_STUB_AUTH=true is forbidden in production'
    );
    return false;
  }

  return allowStubAuth;
}
