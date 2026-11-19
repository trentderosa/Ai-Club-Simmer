import { randomUUID } from 'crypto';
import { CheckInIdempotencyConflict } from '../types/check-in.js';

export interface GeneratedCheckInRecord {
  id: string;
  user_id: string;
  generated_recipe_id: string;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  is_repeat: boolean;
  created_at: Date;
  created: boolean;
}

export interface CreateGeneratedCheckInParams {
  id?: string;
  user_id: string;
  generated_recipe_id: string;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
}

export interface GeneratedCheckInRepository {
  validateRecipe(userId: string, generatedRecipeId: string): Promise<boolean>;
  create(params: CreateGeneratedCheckInParams): Promise<GeneratedCheckInRecord>;
  /** The dish the user asked for (dish_query), for the coach note. Null if not found. */
  getDishName?(userId: string, generatedRecipeId: string): Promise<string | null>;
}

export class InMemoryGeneratedCheckInRepository implements GeneratedCheckInRepository {
  private readonly recipes = new Set<string>();
  private readonly checkIns = new Map<string, GeneratedCheckInRecord>();

  private readonly dishNames = new Map<string, string>();

  seedRecipe(userId: string, generatedRecipeId: string, dishName?: string): void {
    this.recipes.add(`${userId}:${generatedRecipeId}`);
    if (dishName) this.dishNames.set(`${userId}:${generatedRecipeId}`, dishName);
  }

  getDishName(userId: string, generatedRecipeId: string): Promise<string | null> {
    return Promise.resolve(this.dishNames.get(`${userId}:${generatedRecipeId}`) ?? null);
  }

  validateRecipe(userId: string, generatedRecipeId: string): Promise<boolean> {
    return Promise.resolve(this.recipes.has(`${userId}:${generatedRecipeId}`));
  }

  async create(params: CreateGeneratedCheckInParams): Promise<GeneratedCheckInRecord> {
    const ok = await this.validateRecipe(params.user_id, params.generated_recipe_id);
    if (!ok) throw new Error('Invalid generated_recipe_id');

    if (params.id) {
      const existing = this.checkIns.get(params.id);
      if (existing) {
        if (
          existing.user_id === params.user_id &&
          existing.generated_recipe_id === params.generated_recipe_id
        ) {
          return { ...existing, created: false };
        }
        throw new CheckInIdempotencyConflict();
      }
    }

    const record: GeneratedCheckInRecord = {
      id: params.id ?? randomUUID(),
      user_id: params.user_id,
      generated_recipe_id: params.generated_recipe_id,
      difficulty_rating: params.difficulty_rating,
      went_well: params.went_well,
      was_hard: params.was_hard,
      is_repeat: false,
      created_at: new Date(),
      created: true,
    };
    this.checkIns.set(record.id, record);
    return record;
  }
}
