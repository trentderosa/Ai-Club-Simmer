/**
 * Loads one slot's plan row + recipe, using the flow cache when it can.
 * Shared by the recipe, cook-mode and check-in screens.
 */
import type { PlanSlot, RecipeResponse } from '../api';
import { ApiError } from '../api';
import { useFlowCache } from './flow-cache';
import { useSession } from './session';
import { useAsync } from './use-async';

export interface SlotRecipe {
  slot: PlanSlot;
  recipe: RecipeResponse;
}

export function useSlotRecipe(slotId: number) {
  const { backend, requireSession } = useSession();
  const cache = useFlowCache();
  return useAsync<SlotRecipe>(async () => {
    if (!Number.isInteger(slotId) || slotId < 1) throw new ApiError('not_found', 'Unknown recipe.');
    const session = requireSession();
    const plan = cache.getPlan() ?? (await backend.getPlan());
    cache.setPlan(plan);
    const slot = plan.find((s) => s.slot_id === slotId);
    if (!slot) throw new ApiError('not_found', `Path slot ${slotId} not found`, 404);
    const recipe = cache.getRecipe(slotId) ?? (await backend.generateRecipe(slotId, session.accessToken));
    cache.setRecipe(slotId, recipe);
    return { slot, recipe };
  }, [slotId]);
}
