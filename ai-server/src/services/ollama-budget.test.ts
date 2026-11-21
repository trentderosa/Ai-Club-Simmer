import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaClient } from './ollama-client.js';
import { OllamaBusyError } from './ollama-gate.js';
import { startDeadline } from './ollama-budget.js';
import { generateRecipe, type RecipeGenerationResponse } from './recipe-generator.js';
import { generateCookAnythingRecipe } from '../cook-anything/generator.js';
import { createCoachNoteGenerator, FALLBACK_NOTE } from './coach-note.js';
import type { UserProfile } from '../schemas/user.js';

const user: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'a_little',
  budget: 'low',
  equipment: ['stove', 'pan'],
};
const slot = { id: 1, dishName: 'Scrambled Eggs', techniqueFocus: 'heat control' };

/** A fake clock and a client whose every call burns `burnMs` and returns bad output. */
function setup(burnMs: number): {
  clock: { t: number };
  now: () => number;
  client: OllamaClient & { generate: ReturnType<typeof vi.fn> };
} {
  const clock = { t: 0 };
  const client = {
    generate: vi.fn().mockImplementation(() => {
      clock.t += burnMs;
      return Promise.resolve('not-json');
    }),
  };
  return { clock, now: () => clock.t, client };
}

const budgetOf = (now: () => number, budgetMs: number): Parameters<typeof startDeadline>[0] => ({
  budgetMs,
  ollamaTimeoutMs: 60000,
  queueTimeoutMs: 60000,
  now,
});

const budgetLogs = (): unknown[][] =>
  vi.mocked(console.warn).mock.calls.filter((c) => c[0] === 'recipe_generation_budget_exhausted');

describe('startDeadline', () => {
  it('gives min(queue timeout, remaining minus the Ollama timeout)', () => {
    const { clock, now } = setup(0);
    const deadline = startDeadline(budgetOf(now, 100000));
    expect(deadline.nextQueueTimeoutMs()).toBe(40000);
    clock.t = 30000;
    expect(deadline.nextQueueTimeoutMs()).toBe(10000);
    clock.t = 40000;
    expect(deadline.nextQueueTimeoutMs()).toBe(0);
    const roomy = startDeadline({ ...budgetOf(now, 600000), queueTimeoutMs: 5000 });
    expect(roomy.nextQueueTimeoutMs()).toBe(5000);
  });
});

describe('per-request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('generateRecipe trims each queue wait and stops with the earlier failure when the budget runs out', async () => {
    const { now, client } = setup(30000);
    const promise = generateRecipe(client, slot, user, { budget: budgetOf(now, 100000) });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(client.generate.mock.calls[0][2]).toEqual({ queueTimeoutMs: 40000 });
    expect(client.generate.mock.calls[1][2]).toEqual({ queueTimeoutMs: 10000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('generation_failed');
      expect(result.error.attempts).toBe(2);
    }
    expect(budgetLogs()).toHaveLength(1);
  });

  it('generateRecipe returns busy when the budget cannot cover even one attempt', async () => {
    const { now, client } = setup(0);
    const result = await generateRecipe(client, slot, user, { budget: budgetOf(now, 10000) });
    expect(client.generate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('busy');
    expect(budgetLogs()).toHaveLength(1);
  });

  it('generateRecipe without a budget passes no options to the client', async () => {
    const client = { generate: vi.fn().mockResolvedValue('not-json') };
    const promise = generateRecipe(client, slot, user);
    await vi.runAllTimersAsync();
    await promise;
    expect(client.generate).toHaveBeenCalledTimes(3);
    expect(client.generate.mock.calls[0]).toHaveLength(2);
  });

  it('generateCookAnythingRecipe trims each queue wait and stops with the earlier failure', async () => {
    const { now, client } = setup(30000);
    const promise = generateCookAnythingRecipe(client, 'Pad Thai', user, {
      budget: budgetOf(now, 100000),
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(client.generate.mock.calls[0][2]).toEqual({ queueTimeoutMs: 40000 });
    expect(client.generate.mock.calls[1][2]).toEqual({ queueTimeoutMs: 10000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('generation_failed');
      expect(result.error.attempts).toBe(2);
    }
    expect(budgetLogs()).toHaveLength(1);
  });

  it('generateCookAnythingRecipe returns busy when the budget cannot cover one attempt', async () => {
    const { now, client } = setup(0);
    const result = await generateCookAnythingRecipe(client, 'Pad Thai', user, {
      budget: budgetOf(now, 10000),
    });
    expect(client.generate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('busy');
  });

  it('busy on attempt 2 after a normal failure on attempt 1 makes no further attempts', async () => {
    for (const run of [
      (c: OllamaClient): Promise<RecipeGenerationResponse> => generateRecipe(c, slot, user),
      (c: OllamaClient): Promise<RecipeGenerationResponse> =>
        generateCookAnythingRecipe(c, 'Pad Thai', user),
    ]) {
      const client = {
        generate: vi
          .fn()
          .mockResolvedValueOnce('not-json')
          .mockRejectedValue(new OllamaBusyError('queue_timeout')),
      };
      const promise = run(client);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(client.generate).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe('busy');
        expect(result.error.attempts).toBe(2);
      }
    }
  });

  it('coach note falls back when the budget runs out, trimming each wait', async () => {
    const { now, client } = setup(30000);
    const generator = createCoachNoteGenerator(client, {
      budget: { budgetMs: 100000, ollamaTimeoutMs: 60000, queueTimeoutMs: 15000, now },
    });
    const note = await generator.generate('ok', null, null);
    expect(note).toEqual(FALLBACK_NOTE);
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(client.generate.mock.calls[0][2]).toEqual({ queueTimeoutMs: 15000 });
    expect(client.generate.mock.calls[1][2]).toEqual({ queueTimeoutMs: 10000 });
    const logs = vi.mocked(console.warn).mock.calls.filter((c) => c[0] === 'coach_note_budget_exhausted');
    expect(logs).toHaveLength(1);
  });

  it('coach note falls back without calling the model when the budget is already spent', async () => {
    const { now, client } = setup(0);
    const generator = createCoachNoteGenerator(client, {
      budget: { budgetMs: 5000, ollamaTimeoutMs: 60000, queueTimeoutMs: 15000, now },
    });
    expect(await generator.generate('ok', null, null)).toEqual(FALLBACK_NOTE);
    expect(client.generate).not.toHaveBeenCalled();
  });
});
