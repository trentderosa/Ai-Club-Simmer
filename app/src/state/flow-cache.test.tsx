import { act } from 'react';
import TestRenderer from 'react-test-renderer';

import type { PlanSlot, RecipeResponse } from '../api';
import { FlowCacheProvider, useFlowCache, type FlowCache } from './flow-cache';

const slot = (slot_id: number, status: PlanSlot['status']): PlanSlot => ({
  slot_id,
  slot_order: slot_id,
  dish_name: `Dish ${slot_id}`,
  technique_focus: 'x',
  xp_value: 10,
  is_final: false,
  status,
  has_recipe: false,
  times_completed: status === 'done' ? 1 : 0,
  first_completed_at: null,
});

function mountCache(): FlowCache {
  let cache!: FlowCache;
  function Probe() {
    cache = useFlowCache();
    return null;
  }
  act(() => {
    TestRenderer.create(
      <FlowCacheProvider>
        <Probe />
      </FlowCacheProvider>,
    );
  });
  return cache;
}

describe('FlowCache notice', () => {
  it('hands a notice over once', () => {
    const cache = mountCache();
    cache.setNotice('hello');
    expect(cache.takeNotice()).toBe('hello');
    expect(cache.takeNotice()).toBeNull();
  });
});

describe('FlowCache.invalidateUnstarted', () => {
  it('drops recipes, plan and summary for slots not done, keeping done slots', () => {
    let cache!: FlowCache;
    function Probe() {
      cache = useFlowCache();
      return null;
    }
    act(() => {
      TestRenderer.create(
        <FlowCacheProvider>
          <Probe />
        </FlowCacheProvider>,
      );
    });
    const recipe = (id: number) => ({ title: `r${id}` }) as unknown as RecipeResponse;
    cache.setPlan([slot(1, 'done'), slot(2, 'current'), slot(3, 'locked')]);
    for (const id of [1, 2, 3]) cache.setRecipe(id, recipe(id));
    cache.invalidateUnstarted();
    expect(cache.getRecipe(1)).not.toBeNull();
    expect(cache.getRecipe(2)).toBeNull();
    expect(cache.getRecipe(3)).toBeNull();
    expect(cache.getPlan()).toBeNull();
    expect(cache.getSummary()).toBeNull();
  });
});
