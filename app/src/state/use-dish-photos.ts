/**
 * Commons photos for screens that know a dish name but not a recipe payload
 * (Today, the recipe book). A failed lookup leaves those names out, and the
 * photo component falls back to the cutting board.
 */
import { useMemo } from 'react';

import type { DishPhoto } from '../api';
import { normalizeDishName } from '../domain/dish-name';
import { useSession } from './session';
import { useAsync } from './use-async';

export function useDishPhotos(names: readonly string[]): Record<string, DishPhoto | null> {
  const { backend, session } = useSession();
  const key = useMemo(
    () => [...new Set(names.map((name) => normalizeDishName(name)).filter((name) => name.length > 0))].sort().join('\n'),
    [names]
  );
  const data = useAsync(async () => {
    if (!key || !session?.accessToken) return {};
    try {
      return await backend.dishPhotos(key.split('\n'), session.accessToken);
    } catch {
      return {};
    }
  }, [backend, key, session?.accessToken]);
  return data.data ?? {};
}
