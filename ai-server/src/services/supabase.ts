import { UserProfile } from '../schemas/user.js';
import { Recipe } from '../schemas/recipe.js';
import type { PathSlot } from './recipe-generator.js';

export interface SupabaseService {
  verifyToken(token: string): Promise<{ valid: boolean; userId?: string }>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  getPathSlot(slotId: number): Promise<PathSlot | null>;
  getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null>;
  saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<void>;
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
    verifyToken(_token: string): Promise<{ valid: boolean; userId?: string }> {
      // SECURITY: Stub auth fails closed by default.
      // Only accepts tokens when explicitly enabled via ALLOW_STUB_AUTH=true.
      if (!allowStubAuth) {
        return Promise.resolve({ valid: false });
      }

      // Stub auth enabled for local dev - accepts any token
      console.warn(
        'STUB AUTH ENABLED - accepting any token as stub-user-id'
      );
      return Promise.resolve({ valid: true, userId: 'stub-user-id' });
    },

    getUserProfile(_userId: string): Promise<UserProfile | null> {
      // TODO: Implement fetching user profile from Supabase
      // Query the users table for equipment, budget, experience, recent check-ins
      return Promise.resolve(null);
    },

    getPathSlot(_slotId: number): Promise<PathSlot | null> {
      // TODO: Implement fetching path slot from Supabase
      // Query the path_slots table for the dish name and technique focus
      return Promise.resolve(null);
    },

    getSavedRecipe(_userId: string, _slotId: number): Promise<Recipe | null> {
      // TODO: Implement fetching saved recipe from Supabase
      // Check if a recipe already exists for this user + slot combination
      return Promise.resolve(null);
    },

    saveRecipe(
      _userId: string,
      _slotId: number,
      _recipe: Recipe
    ): Promise<void> {
      // TODO: Implement saving recipe to Supabase
      // Insert the generated recipe into the user_recipes table
      return Promise.resolve();
    },
  };
}

/**
 * Checks if stub auth is allowed based on environment variables.
 * Returns true only if ALLOW_STUB_AUTH=true AND NODE_ENV is not 'production'.
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
