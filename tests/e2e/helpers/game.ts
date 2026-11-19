/**
 * Plan / XP / badge helpers: reads the way the app does (RPCs and RLS selects
 * with the user's token), seeding via service role, and a model of the XP
 * rules (50% repeat, weekly repeat cap, free-form daily cap) read from xp_config.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { generateSlot, postCheckIn } from './ai.js';
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

/**
 * E2E_REAL_GENERATION=1 makes every setup recipe a real generation through the
 * AI server (Ollama) instead of a service-role seed. Slower, but it exercises
 * the model on every path slot. Timings go to the console and, when
 * E2E_TIMING_FILE is set, to that file as JSON lines.
 */
export const REAL_GENERATION = process.env.E2E_REAL_GENERATION === '1';

export function recordTiming(label: string, slotId: number | string, ms: number, extra: Record<string, unknown> = {}): void {
  console.log(`[timing] ${label} slot ${slotId}: ${(ms / 1000).toFixed(1)}s`);
  const file = process.env.E2E_TIMING_FILE;
  if (file) appendFileSync(file, `${JSON.stringify({ label, slotId, ms, ...extra })}\n`);
}

/**
 * SETUP: give the user a recipe for a path slot. By default it is stored with
 * the service role (no generation). With E2E_REAL_GENERATION=1 it is generated
 * for real through POST /api/recipes/generate/:slotId, which is what the app does.
 */
export async function seedRecipe(user: E2eUser, slotId: number, recipe: Json = MINIMAL_RECIPE): Promise<string> {
  if (REAL_GENERATION) {
    const res = await generateSlot(user.accessToken, slotId);
    recordTiming('setup generation', slotId, res.ms, { status: res.status, cached: res.body?.cached });
    expectOk(res, `generate slot ${slotId}`);
    return userRecipeId(user, slotId);
  }
  return seedRecipeDirect(user, slotId, recipe);
}

/** SETUP (service role): always a stored seed, even in real-generation mode (e.g. a slot the user has not unlocked). */
export async function seedRecipeDirect(user: E2eUser, slotId: number, recipe: Json = MINIMAL_RECIPE): Promise<string> {
  const res = await svcRest('user_recipes', {
    method: 'POST',
    prefer: 'return=representation',
    body: { user_id: user.id, slot_id: slotId, recipe_json: recipe },
  });
  return (expectOk(res, 'seed user_recipes') as Array<{ id: string }>)[0].id;
}

/** INSPECTION (service role): the full stored recipe for a user's path slot. */
export async function storedRecipe(user: E2eUser, slotId: number): Promise<Json> {
  const res = await svcRest(`user_recipes?select=recipe_json&user_id=eq.${user.id}&slot_id=eq.${slotId}`);
  const rows = expectOk(res, 'stored recipe') as Array<{ recipe_json: Json }>;
  if (rows.length !== 1) throw new Error(`expected 1 stored recipe for slot ${slotId}, got ${rows.length}`);
  return rows[0].recipe_json;
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

/** Complete slots with seeded (or, with E2E_REAL_GENERATION=1, generated) recipes and real check-ins; returns the responses. */
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

// The database counts days and weeks from its own clock: award_slot_xp and
// award_generated_recipe_xp use date_trunc(..., NOW() AT TIME ZONE 'UTC'), so
// a UTC day and a UTC week starting Monday, measured at the award's own
// transaction time (the same value xp row created_at gets). The windows below
// are computed from a row's server timestamp, never from the test runner's
// clock, so a run that crosses midnight UTC still matches the server.
function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function utcWeekStart(at: Date): Date {
  const day = utcDayStart(at);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * 86_400_000);
}

/**
 * Reads the user's own xp rows (RLS) and sums what the DB caps look at.
 *
 * With awardCheckInId: the state the award for that check-in saw, i.e. rows
 * strictly before that award row, inside the day and week of its created_at
 * (call it after the check-in). Without it: the state as of the newest row.
 */
export async function readXpState(user: E2eUser, awardCheckInId?: string): Promise<XpState> {
  const slotRows = expectOk(
    await rest(user.accessToken, 'xp_events?select=check_in_id,xp_awarded,is_first_completion,created_at'),
    'xp_events'
  ) as Json[];
  const genRows = expectOk(
    await rest(user.accessToken, 'generated_recipe_xp_events?select=check_in_id,xp_awarded,is_first_completion,created_at'),
    'generated_recipe_xp_events'
  ) as Json[];
  const all = [...slotRows, ...genRows];
  const at = (r: Json) => new Date(r.created_at).getTime();
  let rows = all;
  let anchor: number;
  if (awardCheckInId) {
    const award = all.find((r) => r.check_in_id === awardCheckInId);
    if (!award) throw new Error('readXpState: no xp row for the given check-in');
    anchor = at(award);
    rows = all.filter((r) => r !== award && at(r) < anchor);
  } else {
    if (all.length === 0) return { weeklyRepeatUsed: 0, dailyUsed: 0 };
    anchor = Math.max(...all.map(at));
  }
  const week = utcWeekStart(new Date(anchor)).getTime();
  const day = utcDayStart(new Date(anchor)).getTime();
  return {
    weeklyRepeatUsed: rows.filter((r) => !r.is_first_completion && at(r) >= week).reduce((s, r) => s + r.xp_awarded, 0),
    dailyUsed: rows.filter((r) => at(r) >= day).reduce((s, r) => s + r.xp_awarded, 0),
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
