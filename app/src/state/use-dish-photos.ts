/**
 * Commons photos for screens that know a dish name but not a recipe payload
 * (Today, the recipe book). A failed lookup leaves those names out, and the
 * photo component falls back to the cutting board. An outage (unreachable,
 * timeout, 429, 503) is reported separately so Today can offer a retry
 * without hiding the plan.
 */
import { useMemo } from 'react';

import type { DishPhoto } from '../api';
import { normalizeDishName } from '../domain/dish-name';
import { isAiServerOutage } from '../domain/error-messages';
import { useSession } from './session';
import { useAsync } from './use-async';

export interface DishPhotoLookup {
  photos: Record<string, DishPhoto | null>;
  /** Set only for an AI-server outage. Other failures stay a quiet photo fallback. */
  outage: unknown | null;
  retry: () => void;
}

export function useDishPhotos(names: readonly string[]): DishPhotoLookup {
  const { backend, session } = useSession();
  const key = useMemo(
    () => [...new Set(names.map((name) => normalizeDishName(name)).filter((name) => name.length > 0))].sort().join('\n'),
    [names]
  );
  const data = useAsync(async () => {
    if (!key || !session?.accessToken) return {};
    return await backend.dishPhotos(key.split('\n'), session.accessToken);
  }, [backend, key, session?.accessToken]);
  return {
    photos: data.data ?? {},
    outage: data.status === 'error' && isAiServerOutage(data.error) ? data.error : null,
    retry: data.reload,
  };
}
