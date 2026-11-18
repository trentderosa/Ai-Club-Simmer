/**
 * Plan / XP / badge helpers: reads the way the app does (RPCs and RLS selects
 * with the user's token), seeding via service role, and a model of the XP
 * rules (50% repeat, weekly repeat cap, free-form daily cap) read from xp_config.
 */
import { randomUUID } from 'node:crypto';
import { postCheckIn } from './ai.js';
import type { Json } from './http.js';
import { expectOk, rest, rpc, svcRest } from './supabase.js';
import type { E2eUser } from './users.js';

export interface PlanRow {
  slot_id: number;
  slot_order: number;
  dish_name: string;
  xp_value: number;
  is_final: boolean;
  status: 'done' | 'current' | 'locked';
  has_recipe: boolean;
  times_completed: number;
}

export async function getPlan(user: E2eUser): Promise<PlanRow[]> {
  return expectOk(await rpc(user.accessToken, 'get_my_plan'), 'get_my_plan') as PlanRow[];
}

export async function getSummary(user: E2eUser): Promise<Json> {
  const rows = expectOk(await rpc(user.accessToken, 'get_my_plan_summary'), 'get_my_plan_summary') as Json[];
  return rows[0];
}

export async function getBadges(user: E2eUser): Promise<Json[]> {
  return expectOk(await rpc(user.accessToken, 'get_my_badges'), 'get_my_badges');
}

export async function getRecipeBook(user: E2eUser): Promise<Json[]> {
  return expectOk(await rpc(user.accessToken, 'get_my_recipe_book'), 'get_my_recipe_book');
}

export async function pathSlots(): Promise<Array<{ id: number; slot_order: number; xp_value: number; is_final: boolean }>> {
  return expectOk(await rest(null, 'path_slots?select=id,slot_order,xp_value,is_final&order=slot_order'), 'path_slots');
}

export interface XpConfig {
  repeatPct: number;
  weeklyCap: number;
  dailyCap: number;
}

export async function xpConfig(): Promise<XpConfig> {
  const rows = expectOk(await rest(null, 'xp_config?select=key,value'), 'xp_config') as Array<{ key: string; value: number }>;
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.value);
  return { repeatPct: get('repeat_xp_percent'), weeklyCap: get('weekly_repeat_cap'), dailyCap: get('freeform_daily_cap') };
}

export const MINIMAL_RECIPE = {
  title: 'E2E Seed Salad',
  ingredients: [
    { name: 'lettuce', amount: '1 head' },
    { name: 'tomato', amount: '2' },
  ],
  timeEstimateMinutes: 10,
  steps: [
    { instruction: 'Rinse the lettuce under cold water.', whyItMatters: 'Removes grit.', isSafetyStep: false, techniqueName: 'rinse' },
    { instruction: 'Slice the tomato with a sharp knife, curling your fingers.', isSafetyStep: true, techniqueName: 'slice tomato' },
    { instruction: 'Tear the lettuce into bite-size pieces.', whyItMatters: 'Torn leaves hold dressing.', isSafetyStep: false },
    { instruction: 'Toss everything with olive oil and salt.', whyItMatters: 'Seasoning at the end keeps leaves crisp.', isSafetyStep: false },
  ],
};

/** SETUP (service role): store a recipe in user_recipes without paying for a real generation. */
export async function seedRecipe(user: E2eUser, slotId: number, recipe: Json = MINIMAL_RECIPE): Promise<string> {
  const res = await svcRest('user_recipes', {
    method: 'POST',
    prefer: 'return=representation',
    body: { user_id: user.id, slot_id: slotId, recipe_json: recipe },
  });
  return (expectOk(res, 'seed user_recipes') as Array<{ id: string }>)[0].id;
}

/** The app's lookup of user_recipes.id (RLS: own rows, column grant on id). */
export async function userRecipeId(user: E2eUser, slotId: number): Promise<string> {
  const rows = expectOk(
    await rest(user.accessToken, `user_recipes?select=id&slot_id=eq.${slotId}`),
    'user_recipes select'
  ) as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`expected 1 user_recipes row for slot ${slotId}, got ${rows.length}`);
  return rows[0].id;
}

/** A real check-in through the AI server (path slot). */
export async function pathCheckIn(
  user: E2eUser,
  slotId: number,
  extra: Record<string, unknown> = {}
) {
  const user_recipe_id = await userRecipeId(user, slotId);
  return postCheckIn(user.accessToken, {
    user_recipe_id,
    slot_id: slotId,
    rating: 'ok',
    idempotency_key: randomUUID(),
    ...extra,
  });
}

/** Complete slots from..to with seeded recipes and real check-ins; returns the responses. */
export async function completeSlots(user: E2eUser, slotIds: number[]): Promise<Json[]> {
  const out: Json[] = [];
  for (const slotId of slotIds) {
    await seedRecipe(user, slotId);
    const res = await pathCheckIn(user, slotId);
    expectOk(res, `check-in slot ${slotId}`);
    out.push(res.body);
  }
  return out;
}

export interface XpState {
  weeklyRepeatUsed: number;
  dailyUsed: number;
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcWeekStart(now = new Date()): Date {
  const day = utcDayStart(now);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * 86_400_000);
}

/** Reads the user's own xp rows (RLS) and sums what the DB caps look at. */
export async function readXpState(user: E2eUser): Promise<XpState> {
  const slotRows = expectOk(
    await rest(user.accessToken, 'xp_events?select=xp_awarded,is_first_completion,created_at'),
    'xp_events'
  ) as Json[];
  const genRows = expectOk(
    await rest(user.accessToken, 'generated_recipe_xp_events?select=xp_awarded,is_first_completion,created_at'),
    'generated_recipe_xp_events'
  ) as Json[];
  const all = [...slotRows, ...genRows];
  const week = utcWeekStart().getTime();
  const day = utcDayStart().getTime();
  const at = (r: Json) => new Date(r.created_at).getTime();
  return {
    weeklyRepeatUsed: all.filter((r) => !r.is_first_completion && at(r) >= week).reduce((s, r) => s + r.xp_awarded, 0),
    dailyUsed: all.filter((r) => at(r) >= day).reduce((s, r) => s + r.xp_awarded, 0),
  };
}

/** Expected award per the documented rules. dailyCap is null for path-slot awards. */
export function modelAward(args: {
  base: number;
  isFirst: boolean;
  cfg: XpConfig;
  state: XpState;
  applyDailyCap: boolean;
}): { xp: number; capped: boolean } {
  const { base, isFirst, cfg, state } = args;
  let xp = isFirst ? base : Math.floor((base * cfg.repeatPct) / 100);
  let capped = false;
  if (!isFirst) {
    if (state.weeklyRepeatUsed >= cfg.weeklyCap) {
      xp = 0;
      capped = true;
    } else if (state.weeklyRepeatUsed + xp > cfg.weeklyCap) {
      xp = cfg.weeklyCap - state.weeklyRepeatUsed;
      capped = true;
    }
  }
  if (args.applyDailyCap) {
    if (state.dailyUsed >= cfg.dailyCap) {
      xp = 0;
      capped = true;
    } else if (state.dailyUsed + xp > cfg.dailyCap) {
      xp = cfg.dailyCap - state.dailyUsed;
      capped = true;
    }
  }
  return { xp, capped };
}
