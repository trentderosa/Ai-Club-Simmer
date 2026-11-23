import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecipeRouter } from './recipe.js';
import { createPathRecipeService } from '../services/path-recipe-service.js';
import { createOllamaGate } from '../services/ollama-gate.js';
import { createRecipePrewarmer } from '../services/recipe-prewarmer.js';
import { createCoachNoteGenerator } from '../services/coach-note.js';
import type { OllamaClient } from '../services/ollama-client.js';
import type { SupabaseService } from '../services/supabase.js';
import type { Recipe } from '../schemas/recipe.js';

const recipe: Recipe = {
  title: 'Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs well', isSafetyStep: false }],
};
const slot = { id: 2, dishName: 'Eggs', techniqueFocus: 'Heat', isFinal: false };
const profile = { id: 'x', experienceLevel: 'never_cooked' as const, budget: 'low' as const, equipment: ['pan'] };
const budget = { budgetMs: 60_000, ollamaTimeoutMs: 1000, queueTimeoutMs: 5000 };

interface FakeCall {
  prompt: string;
  signal?: AbortSignal;
  resolve: (text: string) => void;
}

/** Model whose calls stay pending until settled; a signal abort rejects the call. */
function fakeModel(): { client: OllamaClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const client: OllamaClient = {
    generate: (prompt, _schema, options) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ prompt, signal: options?.signal, resolve });
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
  return { client, calls };
}

function makeSupabase(): { supabase: SupabaseService; saveRecipe: ReturnType<typeof vi.fn> } {
  const saveRecipe = vi.fn().mockImplementation((_u: string, _s: number, r: Recipe) => Promise.resolve(r));
  const supabase = {
    verifyToken: vi.fn().mockImplementation((token: string) => Promise.resolve({ valid: true, userId: token })),
    getUserProfile: vi.fn().mockImplementation((id: string) => Promise.resolve({ ...profile, id })),
    getPathSlot: vi.fn().mockResolvedValue(slot),
    isSlotUnlocked: vi.fn().mockResolvedValue(true),
    getSavedRecipe: vi.fn().mockResolvedValue(null),
    getSavedVideos: vi.fn().mockResolvedValue(null),
    saveVideos: vi.fn().mockResolvedValue(undefined),
    saveRecipe,
  } as unknown as SupabaseService;
  return { supabase, saveRecipe };
}

function setup(): ReturnType<typeof fakeModel> & {
  app: express.Express;
  gate: ReturnType<typeof createOllamaGate>;
  pathRecipes: ReturnType<typeof createPathRecipeService>;
  prewarmer: ReturnType<typeof createRecipePrewarmer>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  saveRecipe: ReturnType<typeof vi.fn>;
} {
  const model = fakeModel();
  const gate = createOllamaGate(model.client, { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 5000 });
  const { supabase, saveRecipe } = makeSupabase();
  const pathRecipes = createPathRecipeService({ ollamaClient: gate, supabase, generationBudget: budget });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/recipes',
    createRecipeRouter({ ollamaClient: gate, supabase, pathRecipes, generationBudget: budget })
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const prewarmer = createRecipePrewarmer({
    pathRecipes,
    supabase,
    pathRepository: { getNextPathSlot: vi.fn().mockResolvedValue(slot) },
    gate,
    logger,
  });
  return { ...model, app, gate, pathRecipes, prewarmer, logger, saveRecipe };
}

const post = (app: express.Express, token: string): Promise<request.Response> =>
  request(app)
    .post('/api/recipes/generate/2')
    .set('Authorization', `Bearer ${token}`)
    .send({})
    .then((r) => r);

describe('prewarm preemption', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a request from another user starts right away, cancels the prewarm, and nothing is retried or saved for it', async () => {
    const t = setup();
    const prewarm = t.prewarmer.prewarm('userA', 1);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.calls[0].signal).toBeDefined();

    const response = post(t.app, 'userB');
    // B's generate begins while the prewarm's generation is still unfinished.
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    expect(t.calls[0].signal?.aborted).toBe(true);
    t.calls[1].resolve(JSON.stringify(recipe));
    expect((await response).status).toBe(200);
    await prewarm;

    expect(t.calls).toHaveLength(2); // the prewarm was not retried
    expect(t.logger.warn).toHaveBeenCalledWith('recipe_prewarm_failed', { slot_id: 2, error: 'preempted' });
    expect(t.saveRecipe).toHaveBeenCalledTimes(1);
    expect(t.saveRecipe.mock.calls[0][0]).toBe('userB');
    expect(t.gate.isIdle()).toBe(true);
  });

  it('a joiner of a preempted prewarm gets a recipe from its own generation', async () => {
    const t = setup();
    const prewarm = t.prewarmer.prewarm('userA', 1);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    const joiner = post(t.app, 'userA'); // joins userA's in-flight prewarm
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls).toHaveLength(1);

    const other = post(t.app, 'userB'); // preempts the prewarm
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    t.calls[1].resolve(JSON.stringify(recipe));
    expect((await other).status).toBe(200);
    // The joiner now generates for itself (foreground) and succeeds.
    await vi.waitFor(() => expect(t.calls).toHaveLength(3));
    expect(t.calls[2].signal).toBeUndefined();
    t.calls[2].resolve(JSON.stringify(recipe));
    const response = await joiner;
    await prewarm;

    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect((t.saveRecipe.mock.calls as string[][]).map((c) => c[0]).sort()).toEqual(['userA', 'userB']);
    expect(t.logger.warn).toHaveBeenCalledWith('recipe_prewarm_failed', { slot_id: 2, error: 'preempted' });
  });

  it('a coach note (foreground) arriving mid-prewarm preempts it', async () => {
    const t = setup();
    const notes = createCoachNoteGenerator(t.gate, { queueTimeoutMs: 5000 });
    const prewarm = t.prewarmer.prewarm('userA', 1);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));

    const note = notes.generate('ok', 'fine', null);
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    expect(t.calls[0].signal?.aborted).toBe(true);
    t.calls[1].resolve(JSON.stringify({ note: 'Nice work on the eggs, keep the heat low.', focus_area: 'heat' }));
    await expect(note).resolves.toMatchObject({ focus_area: 'heat' });
    await prewarm;
    expect(t.calls).toHaveLength(2);
  });
});
