import { UserProfile } from '../schemas/user.js';
import { Recipe } from '../schemas/recipe.js';
import type { PathSlot } from './recipe-generator.js';
import type { JwtVerifier, JwtVerifyResult } from './jwt-verifier.js';
import type { UserRecipeRepository } from '../repositories/user-recipe-repository.js';

export interface SupabaseService {
  verifyToken(token: string): Promise<JwtVerifyResult>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  getPathSlot(slotId: number): Promise<PathSlot | null>;
  getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null>;
  saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<Recipe>;
}

export interface SupabaseServiceDeps {
  jwtVerifier: JwtVerifier;
  userRecipeRepository: UserRecipeRepository;
}

export function createSupabaseService(deps: SupabaseServiceDeps): SupabaseService {
  const { jwtVerifier, userRecipeRepository } = deps;

  return {
    verifyToken(token: string): Promise<JwtVerifyResult> {
      return jwtVerifier.verify(token);
    },

    // TODO: Implement fetching user profile from Supabase profiles table
    // Query the profiles table for equipment, budget, experience, recent check-ins
    getUserProfile(_userId: string): Promise<UserProfile | null> {
      return Promise.resolve(null);
    },

    // TODO: Implement fetching path slot from Supabase path_slots table
    // Query the path_slots table for the dish name and technique focus
    getPathSlot(_slotId: number): Promise<PathSlot | null> {
      return Promise.resolve(null);
    },

    async getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null> {
      const saved = await userRecipeRepository.findByUserAndSlot(userId, slotId);
      return saved?.recipe ?? null;
    },

    async saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<Recipe> {
      const saved = await userRecipeRepository.save(userId, slotId, recipe);
      return saved.recipe;
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

    getPathSlot(_slotId: number): Promise<PathSlot | null> {
      return Promise.resolve(null);
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
