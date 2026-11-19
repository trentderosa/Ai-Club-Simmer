import { z } from 'zod';
import { UserProfileSchema, type UserProfile } from '../schemas/user.js';
import type { PathSlot } from '../services/recipe-generator.js';
import { SupabaseRest, type SupabaseRestConfig } from '../services/supabase-rest.js';

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
  getPathSlot(slotId: number): Promise<PathSlot | null>;
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

const ProfileRowSchema = z.object({
  id: z.string(),
  experience_level: z.string().nullable(),
  budget: z.string().nullable(),
  equipment: z.array(z.string()).nullable(),
  onboarding_completed: z.boolean().nullable(),
});

const CheckInRowSchema = z.object({
  difficulty_rating: z.enum(['easy', 'ok', 'hard']),
  went_well: z.string().nullable(),
  was_hard: z.string().nullable(),
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

  constructor(
    config: SupabaseRestConfig,
    private readonly logger: PathRepositoryLogger = console
  ) {
    this.rest = new SupabaseRest(config);
  }

  async getPathSlot(slotId: number): Promise<PathSlot | null> {
    const rows = await this.rest.select<unknown>('path_slots', {
      select: 'id,dish_name,technique_focus,is_final',
      id: `eq.${slotId}`,
    });
    if (rows.length === 0) return null;
    const row = SlotRowSchema.parse(rows[0]);
    return {
      id: row.id,
      dishName: row.dish_name,
      techniqueFocus: row.technique_focus,
      isFinal: row.is_final ?? false,
    };
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const profiles = await this.rest.select<unknown>('profiles', {
      select: 'id,experience_level,budget,equipment,onboarding_completed',
      id: `eq.${userId}`,
    });
    if (profiles.length === 0) return null;
    const profile = ProfileRowSchema.parse(profiles[0]);
    if (!profile.onboarding_completed || !profile.experience_level || !profile.budget) {
      return null;
    }

    const checkIns = await this.rest.select<unknown>('check_ins', {
      select: 'difficulty_rating,went_well,was_hard,path_slots(dish_name)',
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: String(RECENT_CHECK_INS_FOR_PROMPT),
    });

    const recentCheckIns = checkIns
      .map((raw) => CheckInRowSchema.parse(raw))
      .reverse() // oldest first; buildPrompt takes the last 3
      .map((c) => {
        const whatWentWell = clampText(c.went_well);
        const whatWasHard = clampText(c.was_hard);
        return {
          recipeName: c.path_slots?.dish_name ?? 'a previous recipe',
          difficulty: c.difficulty_rating,
          ...(whatWentWell ? { whatWentWell } : {}),
          ...(whatWasHard ? { whatWasHard } : {}),
        };
      });

    const parsed = UserProfileSchema.safeParse({
      id: profile.id,
      experienceLevel: profile.experience_level,
      budget: profile.budget,
      equipment: normalizeEquipment(profile.equipment),
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
