import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPathRecipeService } from './path-recipe-service.js';
import { createRecipePrewarmer, type RecipePrewarmerDeps } from './recipe-prewarmer.js';
import { createOllamaGate } from './ollama-gate.js';
import type { OllamaClient } from './ollama-client.js';
import type { SupabaseService } from './supabase.js';
import type { PathSlot } from './recipe-generator.js';
import type { UserProfile } from '../schemas/user.js';
import type { Recipe } from '../schemas/recipe.js';
import type { VideoFinder } from './video-finder.js';

const USER = 'user-1';
const next: PathSlot = { id: 22, dishName: 'Scrambled Eggs', techniqueFocus: 'Heat control', isFinal: false };
const profile: UserProfile = { id: USER, experienceLevel: 'never_cooked', budget: 'low', equipment: ['pan'] };

interface Deferred {
  resolve: (value: string) => void;
}

/** Inner client: every call is recorded and stays pending until the test settles it. */
function pendingClient(): { client: OllamaClient; calls: Deferred[] } {
  const calls: Deferred[] = [];
  const client: OllamaClient = {
    generate: () => new Promise<string>((resolve) => calls.push({ resolve })),
  };
  return { client, calls };
}

function setup(client: OllamaClient): {
  gate: ReturnType<typeof createOllamaGate>;
  pathRecipes: ReturnType<typeof createPathRecipeService>;
  prewarmer: ReturnType<typeof createRecipePrewarmer>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const gate = createOllamaGate(client, { maxConcurrent: 1, maxQueue: 3, queueTimeoutMs: 60000 });
  const supabase = { saveRecipe: vi.fn() } as unknown as SupabaseService;
  const pathRecipes = createPathRecipeService({ ollamaClient: gate, supabase });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: RecipePrewarmerDeps = {
    pathRecipes,
    supabase: {
      isSlotUnlocked: vi.fn().mockResolvedValue(true),
      getSavedRecipe: vi.fn().mockResolvedValue(null),
      getUserProfile: vi.fn().mockResolvedValue(profile),
    },
    pathRepository: { getNextPathSlot: vi.fn().mockResolvedValue(next) },
    gate,
    logger,
  };
  return { gate, pathRecipes, prewarmer: createRecipePrewarmer(deps), logger };
}

describe('path recipe service logging', () => {
  it('sends video warnings through the injected logger, not the console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const logger = { warn: vi.fn() };
      const supabase = { saveVideos: vi.fn() } as unknown as SupabaseService;
      const videoFinder = {
        findForRecipe: vi.fn().mockRejectedValue(new Error('quota exceeded')),
      } as unknown as VideoFinder;
      const service = createPathRecipeService({
        ollamaClient: pendingClient().client,
        supabase,
        videoFinder,
        logger,
      });

      const videos = await service.attachVideos(USER, 22, {} as Recipe);

      expect(videos).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith('recipe_videos_failed', {
        slot_id: 22,
        error: 'quota exceeded',
      });
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

describe('prewarm retries against a real gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a user who joins the prewarm still gets 3 attempts when nobody else is queued', async () => {
    const { client, calls } = pendingClient();
    const { pathRecipes, prewarmer } = setup(client);

    const prewarm = prewarmer.prewarm(USER, 21);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    // The joiner shares the prewarm's generation and options; it holds no queue place.
    const joined = pathRecipes.generate(USER, next, profile);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(i + 1);
      calls[i].resolve('not-json');
    }
    await vi.advanceTimersByTimeAsync(5000);
    const result = await joined;
    await prewarm;

    expect(calls).toHaveLength(3);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.attempts).toBe(3);
  });

  it('stops retrying as soon as another request is waiting', async () => {
    const { client, calls } = pendingClient();
    const { gate, prewarmer, logger } = setup(client);

    const prewarm = prewarmer.prewarm(USER, 21);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    // A real request queues behind the prewarm's running call.
    const other = gate.generate('other', {});
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve('not-json');
    await vi.advanceTimersByTimeAsync(5000);
    await prewarm;

    // The slot went to the waiting request; the prewarm made no second attempt.
    expect(calls).toHaveLength(2);
    expect(vi.mocked(console.warn).mock.calls.some((c) => c[0] === 'recipe_generation_retry_skipped')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('recipe_prewarm_failed', { slot_id: 22, error: 'generation_failed' });
    calls[1].resolve('ok');
    await other;
  });

  it('never waits in the queue: a busy model just stops the prewarm', async () => {
    const { client, calls } = pendingClient();
    const { gate, pathRecipes, logger } = setup(client);
    const prewarmer = createRecipePrewarmer({
      pathRecipes,
      supabase: {
        isSlotUnlocked: vi.fn().mockResolvedValue(true),
        getSavedRecipe: vi.fn().mockResolvedValue(null),
        getUserProfile: vi.fn().mockResolvedValue(profile),
      },
      pathRepository: { getNextPathSlot: vi.fn().mockResolvedValue(next) },
      // Idle at the start check, busy by the time the call reaches the gate.
      gate: { isIdle: vi.fn().mockReturnValue(true) },
      logger,
    });
    const running = gate.generate('other', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await prewarmer.prewarm(USER, 21);

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('recipe_prewarm_failed', { slot_id: 22, error: 'busy' });
    calls[0].resolve('ok');
    await running;
  });

  it('a request joined to a prewarm that shutdown aborts gets busy, with no rerun loop or hang', async () => {
    const calls: Array<() => void> = [];
    const client: OllamaClient = {
      generate: (_p, _s, options) =>
        new Promise<string>((_resolve, reject) => {
          calls.push(() => undefined);
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const { gate, pathRecipes, prewarmer } = setup(client);
    const prewarm = prewarmer.prewarm(USER, 21);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    const joined = pathRecipes.generate(USER, next, profile);
    await vi.advanceTimersByTimeAsync(0);
    gate.close();
    await vi.advanceTimersByTimeAsync(0);
    const result = await joined;
    await prewarm;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('busy');
    // The rerun hit the closed gate and never reached the model.
    expect(calls).toHaveLength(1);
    expect(gate.isIdle()).toBe(true);
  });
});

describe('personalized dishes and in-flight generation', () => {
  it('two users with different dishes for the same slot do not share a generation', async () => {
    const prompts: string[] = [];
    const client: OllamaClient = {
      generate: (prompt) => {
        prompts.push(prompt);
        return new Promise<string>(() => undefined);
      },
    };
    const supabase = { saveRecipe: vi.fn() } as unknown as SupabaseService;
    const service = createPathRecipeService({ ollamaClient: client, supabase });
    const slotA: PathSlot = { ...next, dishName: 'Shakshuka' };
    const slotB: PathSlot = { ...next, dishName: 'Tamago Kake Gohan' };
    void service.generate('user-a', slotA, { ...profile, id: 'user-a' });
    void service.generate('user-b', slotB, { ...profile, id: 'user-b' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(2);
    expect(prompts.some((p) => p.includes('Shakshuka'))).toBe(true);
    expect(prompts.some((p) => p.includes('Tamago Kake Gohan'))).toBe(true);
  });
});
