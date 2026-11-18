/** F2: plan screen RPCs and locked-slot gating on the AI server. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ai } from '../helpers/ai.js';
import { getPlan, getSummary, pathSlots } from '../helpers/game.js';
import { rpc } from '../helpers/supabase.js';
import { Cast, type E2eUser } from '../helpers/users.js';

const cast = new Cast();
let user: E2eUser;
beforeAll(async () => {
  user = await cast.newUser();
});
afterAll(() => cast.cleanup());

describe('F2 plan and gating', () => {
  it('get_my_plan: 10 rows in order, slot 1 current, 2-10 locked', async () => {
    const plan = await getPlan(user);
    const slots = await pathSlots();
    expect(plan).toHaveLength(10);
    expect(plan.map((p) => p.slot_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan[0].status).toBe('current');
    expect(plan.slice(1).every((p) => p.status === 'locked')).toBe(true);
    expect(plan.filter((p) => p.is_final).map((p) => p.slot_order)).toEqual([10]);
    expect(plan.every((p) => p.has_recipe === false && p.times_completed === 0)).toBe(true);
    // xp_value shown on the plan matches path_slots
    for (const row of plan) {
      expect(row.xp_value).toBe(slots.find((s) => s.id === row.slot_id)?.xp_value);
    }
  });

  it('get_my_plan_summary: zero state', async () => {
    const s = await getSummary(user);
    expect(s).toMatchObject({ total_xp: 0, completed_slots: 0, total_slots: 10, current_slot_order: 1, path_complete: false });
    // days_per_week = 3 in onboarding, so the suggestion is between 1 and 3
    expect(s.suggested_sessions_per_week).toBeGreaterThanOrEqual(1);
    expect(s.suggested_sessions_per_week).toBeLessThanOrEqual(3);
  });

  it('plan RPCs need a signed-in user (anon key alone is refused)', async () => {
    const res = await rpc(null, 'get_my_plan');
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/recipes/generate/2 is 403 SLOT_LOCKED', async () => {
    const plan = await getPlan(user);
    const slot2 = plan.find((p) => p.slot_order === 2)!;
    const res = await ai(`/api/recipes/generate/${slot2.slot_id}`, { token: user.accessToken });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SLOT_LOCKED');
  });

  it('slot 10 is locked too; unknown slot is 404; junk slot is 400', async () => {
    const plan = await getPlan(user);
    const slot10 = plan.find((p) => p.slot_order === 10)!;
    const locked = await ai(`/api/recipes/generate/${slot10.slot_id}`, { token: user.accessToken });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe('SLOT_LOCKED');
    expect((await ai('/api/recipes/generate/9999', { token: user.accessToken })).status).toBe(404);
    expect((await ai('/api/recipes/generate/abc', { token: user.accessToken })).status).toBe(400);
  });
});
