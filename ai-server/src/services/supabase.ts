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
  saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<void>;
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

    getUserProfile(_userId: string): Promise<UserProfile | null> {
      return Promise.resolve(null);
    },

    getPathSlot(_slotId: number): Promise<PathSlot | null> {
      return Promise.resolve(null);
    },

    async getSavedRecipe(userId: string, slotId: number): Promise<Recipe | null> {
      const saved = await userRecipeRepository.findByUserAndSlot(userId, slotId);
      return saved?.recipe ?? null;
    },

    async saveRecipe(userId: string, slotId: number, recipe: Recipe): Promise<void> {
      await userRecipeRepository.save(userId, slotId, recipe);
    },
  };
}

export interface SupabaseStubOptions {
  allowStubAuth?: boolean;
}

export function createSupabaseStub(
  options: SupabaseStubOptions = {}
): SupabaseService {
  const allowStubAuth = options.allowStubAuth ?? false;

  return {
    verifyToken(_token: string): Promise<JwtVerifyResult> {
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
      _recipe: Recipe
    ): Promise<void> {
      return Promise.resolve();
    },
  };
}

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
