/**
 * Dish names the AI server already knows for a user: the shared 10-slot path,
 * the curated dish catalog, the user's own path dishes, and that user's Cook
 * anything recipes. POST /api/dish-photos only looks
 * these up, so a client can't send arbitrary names to Wikimedia Commons.
 */
import { z } from 'zod';
import { normalizeDishName } from '../cook-anything/dish-name.js';
import { SupabaseRest, type SupabaseRestConfig } from './supabase-rest.js';
import { UnavailableMemo, isMissingTableError, readOptional } from './optional-schema.js';

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
  // The personalization tables arrive with a later migration: tolerate their absence.
  private readonly noCatalog = new UnavailableMemo();
  private readonly noUserDishes = new UnavailableMemo();

  constructor(
    config: SupabaseRestConfig,
    private readonly logger: { warn(message: string, context: Record<string, unknown>): void } = console
  ) {
    this.rest = new SupabaseRest(config);
  }

  async listForUser(userId: string): Promise<Set<string>> {
    const [pathRows, generatedRows, catalogRows, userDishRows] = await Promise.all([
      this.rest.select<unknown>('path_slots', { select: 'dish_name' }),
      this.rest.select<unknown>('user_generated_recipes', {
        select: 'normalized_dish_name',
        user_id: `eq.${userId}`,
      }),
      readOptional<unknown[]>(
        this.noCatalog,
        isMissingTableError,
        [],
        () => this.rest.select<unknown>('dish_catalog', { select: 'dish_name' }),
        this.logger,
        'dish_catalog'
      ),
      readOptional<unknown[]>(
        this.noUserDishes,
        isMissingTableError,
        [],
        () => this.rest.select<unknown>('user_path_dishes', { select: 'dish_name', user_id: `eq.${userId}` }),
        this.logger,
        'user_path_dishes'
      ),
    ]);
    const pathNames: string[] = [];
    for (const raw of [...pathRows, ...catalogRows, ...userDishRows]) {
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
