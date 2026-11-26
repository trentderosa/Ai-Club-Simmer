import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecipePrewarmer, type RecipePrewarmerDeps } from './recipe-prewarmer.js';
import { createPathRecipeService } from './path-recipe-service.js';
import type { SupabaseService } from './supabase.js';
import type { PathSlot } from './recipe-generator.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';

const USER = 'user-1';
const next: PathSlot = { id: 22, dishName: 'Scrambled Eggs', techniqueFocus: 'Heat control', isFinal: false };
const profile: UserProfile = { id: USER, experienceLevel: 'never_cooked', budget: 'low', equipment: ['pan'] };
const recipe: Recipe = {
  title: 'Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs well', isSafetyStep: false }],
};

interface DepsOverrides {
  idle?: boolean;
  unlocked?: boolean;
  saved?: Recipe | null;
  profile?: UserProfile | null;
  next?: PathSlot | null;
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: RecipePrewarmerDeps;
  generate: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const generate = vi.fn().mockResolvedValue({ success: true, recipe, videos: {} });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: RecipePrewarmerDeps = {
    pathRecipes: { generate, attachVideos: vi.fn() },
    supabase: {
      isSlotUnlocked: vi.fn().mockResolvedValue(overrides.unlocked ?? true),
      getSavedRecipe: vi.fn().mockResolvedValue(overrides.saved ?? null),
      getUserProfile: vi.fn().mockResolvedValue('profile' in overrides ? overrides.profile : profile),
    },
    pathRepository: { getNextPathSlot: vi.fn().mockResolvedValue('next' in overrides ? overrides.next : next) },
    gate: { isIdle: vi.fn().mockReturnValue(overrides.idle ?? true) },
    logger,
  };
  return { deps, generate, logger };
}

describe('RecipePrewarmer', () => {
  it('generates the dish the repository returns for this user', async () => {
    const mine = { ...next, dishName: 'Shakshuka' };
    const { deps, generate } = makeDeps({ next: mine });
    await createRecipePrewarmer(deps).prewarm(USER, 21);
    expect(deps.pathRepository.getNextPathSlot).toHaveBeenCalledWith(21, USER);
    expect(generate).toHaveBeenCalledWith(USER, mine, profile, expect.anything());
  });

  it('generates the next slot and logs started and done', async () => {
    const { deps, generate, logger } = makeDeps();
    await createRecipePrewarmer(deps).prewarm(USER, 21);
    expect(deps.pathRepository.getNextPathSlot).toHaveBeenCalledWith(21, USER);
    expect(generate).toHaveBeenCalledWith(USER, next, profile, {
      shouldRetry: expect.any(Function) as () => boolean,
      immediateOnly: true,
    });
    expect(logger.info).toHaveBeenCalledWith('recipe_prewarm_started', { slot_id: 22 });
    expect(logger.info).toHaveBeenCalledWith(
      'recipe_prewarm_done',
      expect.objectContaining({ slot_id: 22, duration_ms: expect.any(Number) as number })
    );
  });

  it.each([
    ['no_next_slot', { next: null }],
    ['next_slot_locked', { unlocked: false }],
    ['already_saved', { saved: recipe }],
    ['no_profile', { profile: null }],
    ['model_busy', { idle: false }],
  ])('skips with reason %s', async (reason, overrides) => {
    const { deps, generate, logger } = makeDeps(overrides);
    await createRecipePrewarmer(deps).prewarm(USER, 21);
    expect(generate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('recipe_prewarm_skipped', expect.objectContaining({ reason }));
  });

  it('allows the mastery slot as the next slot', async () => {
    const { deps, generate } = makeDeps({ next: { ...next, id: 10, isFinal: true } });
    await createRecipePrewarmer(deps).prewarm(USER, 9);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('swallows and logs thrown errors without prompt or profile data', async () => {
    const { deps, logger } = makeDeps();
    (deps.supabase.getUserProfile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    await expect(createRecipePrewarmer(deps).prewarm(USER, 21)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'recipe_prewarm_failed',
      expect.objectContaining({ error: 'Error' })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('db down');
  });

  it('logs a failed generation result', async () => {
    const { deps, generate, logger } = makeDeps();
    generate.mockResolvedValue({ success: false, error: { type: 'busy', message: 'x', attempts: 1 } });
    await createRecipePrewarmer(deps).prewarm(USER, 21);
    expect(logger.warn).toHaveBeenCalledWith('recipe_prewarm_failed', { slot_id: 22, error: 'busy' });
    expect(logger.info).not.toHaveBeenCalledWith('recipe_prewarm_done', expect.anything());
  });

  it('a second generate for the same user and slot joins the prewarm (one model call)', async () => {
    let release: (v: string) => void = () => undefined;
    const ollamaClient = {
      generate: vi.fn().mockImplementation(
        () => new Promise<string>((resolve) => { release = resolve; })
      ),
    };
    const supabase = {
      saveRecipe: vi.fn().mockImplementation((_u: string, _s: number, r: Recipe) => Promise.resolve(r)),
      getPathSlot: vi.fn().mockResolvedValue(next),
      getUserProfile: vi.fn().mockResolvedValue(profile),
    } as unknown as SupabaseService;
    const pathRecipes = createPathRecipeService({ ollamaClient, supabase });
    const { deps } = makeDeps();
    const prewarmer = createRecipePrewarmer({ ...deps, pathRecipes });

    const prewarm = prewarmer.prewarm(USER, 21);
    await vi.waitFor(() => expect(ollamaClient.generate).toHaveBeenCalledTimes(1));
    const joined = pathRecipes.generate(USER, next, profile);
    release(JSON.stringify(recipe));
    const result = await joined;
    await prewarm;

    expect(ollamaClient.generate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(supabase.saveRecipe).toHaveBeenCalledTimes(1);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
