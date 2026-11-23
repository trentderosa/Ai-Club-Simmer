import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaClient } from './ollama-client.js';
import { OllamaBusyError } from './ollama-gate.js';
import { generateRecipe } from './recipe-generator.js';
import { generateCookAnythingRecipe } from '../cook-anything/generator.js';
import { createCoachNoteGenerator, FALLBACK_NOTE } from './coach-note.js';
import type { UserProfile } from '../schemas/user.js';

const user: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'a_little',
  budget: 'low',
  equipment: ['stove', 'pan'],
};

function busyClient(): OllamaClient & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn().mockRejectedValue(new OllamaBusyError('queue_full')) };
}

describe('busy model handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('path recipe generation stops at the first busy error and reports busy', async () => {
    const client = busyClient();
    const result = await generateRecipe(
      client,
      { id: 1, dishName: 'Scrambled Eggs', techniqueFocus: 'heat control' },
      user
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('busy');
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  it('cook anything generation stops at the first busy error and reports busy', async () => {
    const client = busyClient();
    const result = await generateCookAnythingRecipe(client, 'Pad Thai', user);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('busy');
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  it('coach note returns the fallback at once on busy, logging coach_note_busy once', async () => {
    const client = busyClient();
    const generator = createCoachNoteGenerator(client, { queueTimeoutMs: 1234 });
    const note = await generator.generate('ok', null, null);
    expect(note).toEqual(FALLBACK_NOTE);
    expect(client.generate).toHaveBeenCalledTimes(1);
    expect(client.generate.mock.calls[0][2]).toEqual({ queueTimeoutMs: 1234 });
    const busyLogs = vi.mocked(console.warn).mock.calls.filter((c) => c[0] === 'coach_note_busy');
    expect(busyLogs).toHaveLength(1);
  });
});
