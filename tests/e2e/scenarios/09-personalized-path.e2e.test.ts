/**
 * Personalized path: onboarding food preferences -> personalize_my_path ->
 * the user's own dish per technique slot, generated for real through Ollama,
 * with dietary needs honored end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSlot } from '../helpers/ai.js';
import type { Json } from '../helpers/http.js';
import { getPlan, pathCheckIn } from '../helpers/game.js';
import { rpc, svcRest } from '../helpers/supabase.js';
import { Cast, onboard, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let veg: E2eUser;
let plain: E2eUser;

// Meat, poultry and seafood words a vegetarian recipe must not contain.
const MEAT = /\b(chicken|beef|pork|bacon|ham|sausage|turkey|lamb|steak|salmon|tuna|shrimp|prawns?|fish sauce|anchov(y|ies)|gelatin)\b/i;

type Pick = { slot_id: number; dish_name: string };

beforeAll(async () => {
  veg = await cast.newUser({ onboard: false });
  await onboard(veg, { cuisines: ['mexican'], meal_types: ['quick_weeknight'], dietary_needs: ['vegetarian'] });
  plain = await cast.newUser(); // standard onboarding, no food preferences
});
afterAll(() => cast.cleanup());

async function catalogContains(dish: string, slotId: number): Promise<string[]> {
  const res = await svcRest(
    `dish_catalog?select=contains&slot_id=eq.${slotId}&dish_name=eq.${encodeURIComponent(dish)}`
  );
  const rows = res.body as Array<{ contains: string[] }>;
  return rows[0]?.contains ?? [];
}

describe('personalized path', () => {
  let picks: Pick[] = [];

  it('personalize_my_path picks 10 vegetarian dishes, Mexican where possible', async () => {
    const res = await rpc(veg.accessToken, 'personalize_my_path');
    expect(res.status).toBe(200);
    picks = res.body as Pick[];
    console.log('[picks] vegetarian + mexican:\n' + picks.map((p) => `  ${p.slot_id}: ${p.dish_name}`).join('\n'));
    expect(picks).toHaveLength(10);
    for (const p of picks) {
      const contains = await catalogContains(p.dish_name, p.slot_id);
      expect(contains.filter((c) => ['pork', 'beef', 'lamb', 'poultry', 'fish', 'shellfish'].includes(c))).toEqual([]);
    }
  });

  it('the plan shows the personalized dish names', async () => {
    const plan = (await getPlan(veg)) as unknown as Array<{ slot_id: number; dish_name: string }>;
    for (const p of picks) {
      expect(plan.find((r) => r.slot_id === p.slot_id)?.dish_name).toBe(p.dish_name);
    }
  });

  let slot1: number;
  let slot2: number;

  it('generates a real recipe for the personalized slot 1 dish, with no meat', async () => {
    const plan = (await getPlan(veg)) as unknown as Array<{ slot_id: number; dish_name: string }>;
    slot1 = plan[0].slot_id;
    slot2 = plan[1].slot_id;
    const res = await generateSlot(veg.accessToken, slot1);
    expect(res.status).toBe(200);
    const recipe = (res.body as Json).recipe as Json;
    console.log(`[recipe] slot 1 "${plan[0].dish_name}" -> "${String(recipe.title)}" in ${(res.ms / 1000).toFixed(1)}s`);
    expect(JSON.stringify(recipe)).not.toMatch(MEAT);
  });

  it('after a check-in, the next personalized recipe is generated and stays vegetarian', async () => {
    const ci = await pathCheckIn(veg, slot1, { rating: 'hard', was_hard: 'my knife cuts were uneven and slow' });
    expect([200, 201]).toContain(ci.status);
    const res = await generateSlot(veg.accessToken, slot2);
    expect(res.status).toBe(200);
    const recipe = (res.body as Json).recipe as Json;
    console.log(`[recipe] slot 2 "${String(recipe.title)}" coachNote: ${String(recipe.coachNote ?? '(none)')}`);
    expect(JSON.stringify(recipe)).not.toMatch(MEAT);
  });

  it('adding an allergy clears cached recipes for unstarted slots only', async () => {
    const before = await svcRest(`user_recipes?select=slot_id&user_id=eq.${veg.id}`);
    const slotsBefore = (before.body as Array<{ slot_id: number }>).map((r) => r.slot_id);
    expect(slotsBefore).toContain(slot1);
    expect(slotsBefore).toContain(slot2);
    await onboard(veg, { cuisines: ['mexican'], meal_types: ['quick_weeknight'], dietary_needs: ['vegetarian', 'nut_free'] });
    const after = await svcRest(`user_recipes?select=slot_id&user_id=eq.${veg.id}`);
    const slotsAfter = (after.body as Array<{ slot_id: number }>).map((r) => r.slot_id);
    expect(slotsAfter).toContain(slot1); // started (checked in): kept
    expect(slotsAfter).not.toContain(slot2); // unstarted: cleared
  });

  it('re-personalizing never changes a started slot', async () => {
    const res = await rpc(veg.accessToken, 'personalize_my_path');
    expect(res.status).toBe(200);
    const again = res.body as Pick[];
    expect(again.find((p) => p.slot_id === slot1)?.dish_name).toBe(picks.find((p) => p.slot_id === slot1)?.dish_name);
  });

  it('a user with no food preferences keeps the classic 10-dish path', async () => {
    const res = await rpc(plain.accessToken, 'personalize_my_path');
    expect(res.status).toBe(200);
    const plainPicks = res.body as Pick[];
    console.log('[picks] no preferences:\n' + plainPicks.map((p) => `  ${p.slot_id}: ${p.dish_name}`).join('\n'));
    expect(plainPicks).toHaveLength(10);
    const slots = await svcRest('path_slots?select=id,dish_name');
    const canonical = new Map((slots.body as Array<{ id: number; dish_name: string }>).map((s) => [s.id, s.dish_name]));
    for (const p of plainPicks) expect(p.dish_name).toBe(canonical.get(p.slot_id));
  });
});
