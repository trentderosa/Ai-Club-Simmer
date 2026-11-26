import type { PathRepository } from '../repositories/path-repository.js';
import type { SupabaseService } from './supabase.js';
import type { PathRecipeService } from './path-recipe-service.js';
import type { OllamaGate } from './ollama-gate.js';

export interface RecipePrewarmLogger {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

export interface RecipePrewarmerDeps {
  /** The same instance the recipe route uses (shared in-flight map). */
  pathRecipes: PathRecipeService;
  supabase: Pick<SupabaseService, 'isSlotUnlocked' | 'getSavedRecipe' | 'getUserProfile'>;
  pathRepository: Required<Pick<PathRepository, 'getNextPathSlot'>>;
  gate: Pick<OllamaGate, 'isIdle'>;
  logger?: RecipePrewarmLogger;
}

export interface RecipePrewarmer {
  /** Never rejects. Logs a skip reason, success or failure; never logs prompts or user text. */
  prewarm(userId: string, checkedInSlotId: number): Promise<void>;
}

/**
 * After a path check-in, write the user's next slot recipe in the background so
 * it is already saved when they tap it. Starts only when the model is idle,
 * never waits in the queue (a busy answer just stops it), and stops retrying
 * as soon as anyone else is waiting, so it never competes with a real request.
 */
export function createRecipePrewarmer(deps: RecipePrewarmerDeps): RecipePrewarmer {
  const logger = deps.logger ?? console;

  async function prewarm(userId: string, checkedInSlotId: number): Promise<void> {
    const skip = (reason: string, slotId?: number): void => {
      logger.info('recipe_prewarm_skipped', {
        reason,
        checked_in_slot_id: checkedInSlotId,
        ...(slotId !== undefined ? { slot_id: slotId } : {}),
      });
    };
    try {
      const slot = await deps.pathRepository.getNextPathSlot(checkedInSlotId, userId);
      if (!slot) return skip('no_next_slot');
      if (!(await deps.supabase.isSlotUnlocked(userId, slot.id))) return skip('next_slot_locked', slot.id);
      if (await deps.supabase.getSavedRecipe(userId, slot.id)) return skip('already_saved', slot.id);
      const profile = await deps.supabase.getUserProfile(userId);
      if (!profile) return skip('no_profile', slot.id);
      // Checked last, right before the call, so the answer is as fresh as possible.
      if (!deps.gate.isIdle()) return skip('model_busy', slot.id);

      logger.info('recipe_prewarm_started', { slot_id: slot.id });
      const started = Date.now();
      const result = await deps.pathRecipes.generate(userId, slot, profile, {
        shouldRetry: () => deps.gate.isIdle(),
        immediateOnly: true,
      });
      if (!result.success) {
        logger.warn('recipe_prewarm_failed', { slot_id: slot.id, error: result.error.type });
        return;
      }
      logger.info('recipe_prewarm_done', { slot_id: slot.id, duration_ms: Date.now() - started });
    } catch (error) {
      logger.warn('recipe_prewarm_failed', {
        checked_in_slot_id: checkedInSlotId,
        // Name only: messages can echo request values such as user ids.
        error: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }

  return { prewarm };
}
