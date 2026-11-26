import { z } from 'zod';
import { UserProfileSchema, type UserProfile } from '../schemas/user.js';
import type { PathSlot } from '../services/recipe-generator.js';
import { SupabaseRest, type SupabaseRestConfig } from '../services/supabase-rest.js';
import {
  UnavailableMemo,
  isMissingColumnError,
  isMissingTableError,
  readOptional,
} from '../services/optional-schema.js';

/** A badge a check-in just earned (F9), for the on-screen celebration. */
export interface EarnedBadge {
  code: string;
  name: string;
  description: string;
  kind: 'completion' | 'mastery' | 'path_milestone';
}

/**
 * Read-side access to the learning path for the ai-server (service role).
 *
 * - getPathSlot / getUserProfile feed recipe generation (F3).
 * - isSlotUnlocked enforces path order (F2): only done or current slots can
 *   be started.
 * - badgesEarnedBy reports which badges a check-in earned (F9).
 */
export interface PathRepository {
  /** The slot with the user's own dish for it (user_path_dishes), else the canonical dish. */
  getPathSlot(slotId: number, userId: string): Promise<PathSlot | null>;
  /**
   * The slot with its canonical dish and no per-user read, for checks that only
   * need technique focus or isFinal (a user_path_dishes failure can't affect them).
   */
  getCanonicalPathSlot?(slotId: number): Promise<PathSlot | null>;
  /**
   * The slot whose slot_order follows this slot's, or null for the last slot
   * (or an unknown id). Slot ids are a serial column, not the path order, so
   * the order column decides. Carries the user's own dish like getPathSlot.
   */
  getNextPathSlot?(slotId: number, userId: string): Promise<PathSlot | null>;
  /**
   * The user's onboarding answers plus their last few check-ins (oldest
   * first), or null when onboarding isn't finished.
   */
  getUserProfile(userId: string): Promise<UserProfile | null>;
  isSlotUnlocked(userId: string, slotId: number): Promise<boolean>;
  /** The user's onboarding equipment (one small query), for the check-in coach note. */
  getEquipment?(userId: string): Promise<string[]>;
  badgesEarnedBy(checkInId: string): Promise<EarnedBadge[]>;
}

/** How many recent check-ins go into the recipe prompt (buildPrompt uses the last 3). */
export const RECENT_CHECK_INS_FOR_PROMPT = 3;

/** Limits from UserProfileSchema / CheckInSchema (schemas/user.ts). */
export const MAX_EQUIPMENT_ITEMS = 50;
export const MAX_EQUIPMENT_ITEM_LENGTH = 100;
export const MAX_CHECK_IN_TEXT_LENGTH = 1000;

export interface PathRepositoryLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

/**
 * Make stored equipment fit the prompt schema instead of rejecting the user:
 * trim, drop empty items, cut each item to 100 chars, drop duplicates
 * (case-insensitive, first one wins) and keep at most 50 items.
 */
export function normalizeEquipment(equipment: readonly string[] | null): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of equipment ?? []) {
    const item = raw.trim().slice(0, MAX_EQUIPMENT_ITEM_LENGTH).trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_EQUIPMENT_ITEMS) break;
  }
  return result;
}

/**
 * profiles.dietary_needs values as phrases the recipe prompt understands.
 * Unknown values are dropped. Keep the keys in sync with the
 * profiles_dietary_needs_valid CHECK in migration
 * 20261126120000_personalized_path_dishes.sql.
 */
const DIETARY_PHRASES: Readonly<Record<string, string>> = {
  vegetarian: 'vegetarian',
  vegan: 'vegan',
  no_pork: 'no pork',
  no_beef: 'no beef',
  no_poultry: 'no poultry',
  no_fish: 'no fish',
  no_shellfish: 'no shellfish',
  dairy_free: 'dairy-free',
  gluten_free: 'gluten-free',
  nut_free: 'no nuts (allergy)',
  egg_free: 'no eggs',
  no_mushrooms: 'no mushrooms',
  no_spicy: 'not spicy',
};

export function mapDietaryNeeds(values: readonly string[] | null | undefined): string[] {
  const phrases: string[] = [];
  for (const value of values ?? []) {
    const phrase = Object.hasOwn(DIETARY_PHRASES, value) ? DIETARY_PHRASES[value] : undefined;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

/** Cut free-text check-in answers to the schema limit; empty becomes absent. */
function clampText(text: string | null): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, MAX_CHECK_IN_TEXT_LENGTH) : undefined;
}

const SlotRowSchema = z.object({
  id: z.number().int(),
  dish_name: z.string(),
  technique_focus: z.string(),
  is_final: z.boolean().nullable().optional(),
});

const OrderRowSchema = z.object({ slot_order: z.number().int() });

const ProfileRowSchema = z.object({
  id: z.string(),
  experience_level: z.string().nullable(),
  budget: z.string().nullable(),
  equipment: z.array(z.string()).nullable(),
  onboarding_completed: z.boolean().nullable(),
  dietary_needs: z.array(z.string()).nullable().optional(),
});

const OverrideRowSchema = z.object({
  slot_id: z.number().int(),
  dish_name: z.string(),
});

const CheckInRowSchema = z.object({
  difficulty_rating: z.enum(['easy', 'ok', 'hard']),
  went_well: z.string().nullable(),
  was_hard: z.string().nullable(),
  slot_id: z.number().int().nullable().optional(),
  path_slots: z.object({ dish_name: z.string() }).nullable(),
});

const EarnedBadgeSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['completion', 'mastery', 'path_milestone']),
});

export class SupabasePathRepository implements PathRepository {
  private readonly rest: SupabaseRest;
  /** profiles.dietary_needs is not in the database yet. */
  private readonly noDietaryColumn = new UnavailableMemo();
  /** user_path_dishes is not in the database yet. */
  private readonly noUserDishes = new UnavailableMemo();

  constructor(
    config: SupabaseRestConfig,
    private readonly logger: PathRepositoryLogger = console
  ) {
    this.rest = new SupabaseRest(config);
  }

  /** The user's dish names by slot id (empty when they have none or the table is missing). */
  private async userDishOverrides(userId: string, slotId?: number): Promise<Map<number, string>> {
    const rows = await readOptional<unknown[]>(
      this.noUserDishes,
      isMissingTableError,
      [],
      () =>
        this.rest.select<unknown>('user_path_dishes', {
          select: 'slot_id,dish_name',
          user_id: `eq.${userId}`,
          ...(slotId !== undefined ? { slot_id: `eq.${slotId}` } : {}),
        }),
      this.logger,
      'user_path_dishes'
    );
    const overrides = new Map<number, string>();
    for (const raw of rows) {
      const parsed = OverrideRowSchema.safeParse(raw);
      if (parsed.success && parsed.data.dish_name.trim()) {
        overrides.set(parsed.data.slot_id, parsed.data.dish_name);
      }
    }
    return overrides;
  }

  private async toPathSlot(rawRow: unknown, userId: string): Promise<PathSlot> {
    const row = SlotRowSchema.parse(rawRow);
    const override = (await this.userDishOverrides(userId, row.id)).get(row.id);
    return {
      id: row.id,
      dishName: override ?? row.dish_name,
      techniqueFocus: row.technique_focus,
      isFinal: row.is_final ?? false,
    };
  }

  async getPathSlot(slotId: number, userId: string): Promise<PathSlot | null> {
    const rows = await this.selectSlotRows(slotId);
    if (rows.length === 0) return null;
    return this.toPathSlot(rows[0], userId);
  }

  async getCanonicalPathSlot(slotId: number): Promise<PathSlot | null> {
    const rows = await this.selectSlotRows(slotId);
    if (rows.length === 0) return null;
    const row = SlotRowSchema.parse(rows[0]);
    return { id: row.id, dishName: row.dish_name, techniqueFocus: row.technique_focus, isFinal: row.is_final ?? false };
  }

  private selectSlotRows(slotId: number): Promise<unknown[]> {
    return this.rest.select<unknown>('path_slots', {
      select: 'id,dish_name,technique_focus,is_final',
      id: `eq.${slotId}`,
    });
  }

  async getNextPathSlot(slotId: number, userId: string): Promise<PathSlot | null> {
    const current = await this.rest.select<unknown>('path_slots', {
      select: 'slot_order',
      id: `eq.${slotId}`,
    });
    if (current.length === 0) return null;
    const { slot_order } = OrderRowSchema.parse(current[0]);
    const rows = await this.rest.select<unknown>('path_slots', {
      select: 'id,dish_name,technique_focus,is_final',
      slot_order: `gt.${slot_order}`,
      order: 'slot_order.asc',
      limit: '1',
    });
    if (rows.length === 0) return null;
    return this.toPathSlot(rows[0], userId);
  }

  /** The profile row; without dietary_needs when the database does not have that column yet. */
  private async selectProfile(userId: string): Promise<unknown[]> {
    const baseSelect = 'id,experience_level,budget,equipment,onboarding_completed';
    const read = (select: string): Promise<unknown[]> =>
      this.rest.select<unknown>('profiles', { select, id: `eq.${userId}` });
    const withDietary = await readOptional<unknown[] | null>(
      this.noDietaryColumn,
      isMissingColumnError,
      null,
      () => read(`${baseSelect},dietary_needs`),
      this.logger,
      'profiles.dietary_needs'
    );
    return withDietary ?? read(baseSelect);
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const profiles = await this.selectProfile(userId);
    if (profiles.length === 0) return null;
    const profile = ProfileRowSchema.parse(profiles[0]);
    if (!profile.onboarding_completed || !profile.experience_level || !profile.budget) {
      return null;
    }

    const checkIns = await this.rest.select<unknown>('check_ins', {
      select: 'slot_id,difficulty_rating,went_well,was_hard,path_slots(dish_name)',
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: String(RECENT_CHECK_INS_FOR_PROMPT),
    });
    // One extra select, only when there are check-ins to name.
    const overrides = checkIns.length > 0 ? await this.userDishOverrides(userId) : new Map<number, string>();

    const recentCheckIns = checkIns
      .map((raw) => CheckInRowSchema.parse(raw))
      .reverse() // oldest first; buildPrompt takes the last 3
      .map((c) => {
        const whatWentWell = clampText(c.went_well);
        const whatWasHard = clampText(c.was_hard);
        const personal = c.slot_id != null ? overrides.get(c.slot_id) : undefined;
        return {
          recipeName: personal ?? c.path_slots?.dish_name ?? 'a previous recipe',
          difficulty: c.difficulty_rating,
          ...(whatWentWell ? { whatWentWell } : {}),
          ...(whatWasHard ? { whatWasHard } : {}),
        };
      });

    const dietaryNeeds = mapDietaryNeeds(profile.dietary_needs);
    const parsed = UserProfileSchema.safeParse({
      id: profile.id,
      experienceLevel: profile.experience_level,
      budget: profile.budget,
      equipment: normalizeEquipment(profile.equipment),
      ...(dietaryNeeds.length > 0 ? { dietaryNeeds } : {}),
      recentCheckIns,
    });
    if (!parsed.success) {
      // Issue paths and codes only: never the user's values.
      this.logger.warn('user_profile_invalid', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
      return null;
    }
    return parsed.data;
  }

  async getEquipment(userId: string): Promise<string[]> {
    const rows = await this.rest.select<unknown>('profiles', {
      select: 'equipment',
      id: `eq.${userId}`,
    });
    if (rows.length === 0) return [];
    const row = z.object({ equipment: z.array(z.string()).nullable() }).parse(rows[0]);
    return normalizeEquipment(row.equipment);
  }

  async isSlotUnlocked(userId: string, slotId: number): Promise<boolean> {
    const result = await this.rest.rpc<unknown>('is_slot_unlocked', {
      p_user_id: userId,
      p_slot_id: slotId,
    });
    return result === true;
  }

  async badgesEarnedBy(checkInId: string): Promise<EarnedBadge[]> {
    const rows = await this.rest.rpc<unknown>('get_badges_earned_by_check_in', {
      p_check_in_id: checkInId,
    });
    return z.array(EarnedBadgeSchema).parse(rows ?? []);
  }
}
