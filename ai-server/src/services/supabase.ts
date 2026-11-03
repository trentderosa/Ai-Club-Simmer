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

export function createSupabaseStub(): SupabaseService {
  return {
    verifyToken(_token: string): Promise<{ valid: boolean; userId?: string }> {
      // TODO: Implement real Supabase token verification
      // This should decode and verify the JWT using Supabase's auth
      // For now, return a stub response for testing
      console.warn('Supabase token verification not implemented - using stub');
      return Promise.resolve({ valid: true, userId: 'stub-user-id' });
    },

    getUserProfile(_userId: string): Promise<UserProfile | null> {
      // TODO: Implement fetching user profile from Supabase
      // Query the users table for equipment, budget, experience, recent check-ins
      console.warn('Supabase getUserProfile not implemented - using stub');
      return Promise.resolve(null);
    },

    getPathSlot(_slotId: number): Promise<PathSlot | null> {
      // TODO: Implement fetching path slot from Supabase
      // Query the path_slots table for the dish name and technique focus
      console.warn('Supabase getPathSlot not implemented - using stub');
      return Promise.resolve(null);
    },

    getSavedRecipe(_userId: string, _slotId: number): Promise<Recipe | null> {
      // TODO: Implement fetching saved recipe from Supabase
      // Check if a recipe already exists for this user + slot combination
      console.warn('Supabase getSavedRecipe not implemented - using stub');
      return Promise.resolve(null);
    },

    saveRecipe(
      _userId: string,
      _slotId: number,
      _recipe: Recipe
    ): Promise<void> {
      // TODO: Implement saving recipe to Supabase
      // Insert the generated recipe into the user_recipes table
      console.warn('Supabase saveRecipe not implemented - using stub');
      return Promise.resolve();
    },
  };
}
