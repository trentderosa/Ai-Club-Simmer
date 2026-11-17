/**
 * Dish names the AI server already knows for a user: the shared 10-slot path
 * plus that user's Cook anything recipes. POST /api/dish-photos only looks
 * these up, so a client can't send arbitrary names to Wikimedia Commons.
 */
import { z } from 'zod';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';

const PathNameRow = z.object({ dish_name: z.string() });
const GeneratedNameRow = z.object({ normalized_dish_name: z.string() });

export function collectKnownDishNames(
  pathDishNames: readonly string[],
  generatedNormalizedNames: readonly string[]
): Set<string> {
  const names = new Set<string>();
  for (const name of pathDishNames) {
    const key = normalizeDishName(name);
    if (key) names.add(key);
  }
  for (const name of generatedNormalizedNames) {
    const key = normalizeDishName(name);
    if (key) names.add(key);
  }
  return names;
}

export class SupabaseKnownDishNames {
  private readonly rest: SupabaseRest;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async listForUser(userId: string): Promise<Set<string>> {
    const [pathRows, generatedRows] = await Promise.all([
      this.rest.select<unknown>('path_slots', { select: 'dish_name' }),
      this.rest.select<unknown>('user_generated_recipes', {
        select: 'normalized_dish_name',
        user_id: `eq.${userId}`,
      }),
    ]);
    const pathNames: string[] = [];
    for (const raw of pathRows) {
      const parsed = PathNameRow.safeParse(raw);
      if (parsed.success) pathNames.push(parsed.data.dish_name);
    }
    const generatedNames: string[] = [];
    for (const raw of generatedRows) {
      const parsed = GeneratedNameRow.safeParse(raw);
      if (parsed.success) generatedNames.push(parsed.data.normalized_dish_name);
    }
    return collectKnownDishNames(pathNames, generatedNames);
  }
}
