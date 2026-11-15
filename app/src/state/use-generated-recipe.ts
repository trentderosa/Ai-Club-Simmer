import type { CookAnythingResponse } from '../api';
import { ApiError } from '../api';
import { useFlowCache } from './flow-cache';
import { useSession } from './session';
import { useAsync } from './use-async';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useGeneratedRecipe(recipeId: string | undefined) {
  const { backend } = useSession();
  const cache = useFlowCache();
  return useAsync<CookAnythingResponse>(async () => {
    if (!recipeId || !UUID_RE.test(recipeId)) throw new ApiError('not_found', 'Unknown recipe.');
    const cached = cache.getGenerated(recipeId);
    if (cached) return cached;
    const recipe = await backend.getGeneratedRecipe(recipeId);
    cache.setGenerated(recipeId, recipe);
    return recipe;
  }, [recipeId]);
}
