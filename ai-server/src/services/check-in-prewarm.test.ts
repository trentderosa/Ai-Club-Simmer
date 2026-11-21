import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInService, type CheckInRecipePrewarmer } from './check-in-service.js';
import { InMemoryCheckInRepository } from '../repositories/in-memory-check-in-repository.js';
import { InMemoryGeneratedCheckInRepository } from '../repositories/generated-check-in-repository.js';
import type { CoachNoteGenerator } from './coach-note.js';

describe('CheckInService recipe prewarm', () => {
  const userId = randomUUID();
  const recipeId = randomUUID();
  let repository: InMemoryCheckInRepository;
  let coachNoteGenerator: CoachNoteGenerator;
  let logger: { error: ReturnType<typeof vi.fn> };
  const input = { user_recipe_id: recipeId, slot_id: 1, rating: 'ok' as const };

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    coachNoteGenerator = { generate: vi.fn().mockResolvedValue({ note: 'Nice.', focus_area: 'timing' }) };
    logger = { error: vi.fn() };
  });

  function service(prewarmer: CheckInRecipePrewarmer | null): CheckInService {
    return new CheckInService(repository, coachNoteGenerator, null, logger, {
      recipePrewarmer: prewarmer,
      generatedCheckInRepository: new InMemoryGeneratedCheckInRepository(),
    });
  }

  it('prewarms after a created path check-in, after the coach note', async () => {
    const order: string[] = [];
    (coachNoteGenerator.generate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('note');
      return Promise.resolve({ note: 'Nice.' });
    });
    const prewarmer = { prewarm: vi.fn().mockImplementation(() => { order.push('prewarm'); return Promise.resolve(); }) };
    await service(prewarmer).processCheckIn(userId, input);
    await vi.waitFor(() => expect(prewarmer.prewarm).toHaveBeenCalledWith(userId, 1));
    expect(order).toEqual(['note', 'prewarm']);
  });

  it('does not prewarm on an idempotent replay', async () => {
    const prewarmer = { prewarm: vi.fn().mockResolvedValue(undefined) };
    const key = randomUUID();
    const svc = service(prewarmer);
    await svc.processCheckIn(userId, { ...input, idempotency_key: key });
    await vi.waitFor(() => expect(prewarmer.prewarm).toHaveBeenCalledTimes(1));
    await svc.processCheckIn(userId, { ...input, idempotency_key: key });
    await new Promise((r) => setTimeout(r, 10));
    expect(prewarmer.prewarm).toHaveBeenCalledTimes(1);
  });

  it('does not prewarm for Cook anything check-ins', async () => {
    const prewarmer = { prewarm: vi.fn().mockResolvedValue(undefined) };
    const generatedRepo = new InMemoryGeneratedCheckInRepository();
    vi.spyOn(generatedRepo, 'create').mockResolvedValue({ id: randomUUID(), created: true } as never);
    const svc = new CheckInService(repository, coachNoteGenerator, null, logger, {
      recipePrewarmer: prewarmer,
      generatedCheckInRepository: generatedRepo,
    });
    await svc.processCheckIn(userId, { generated_recipe_id: randomUUID(), rating: 'ok' });
    await new Promise((r) => setTimeout(r, 10));
    expect(prewarmer.prewarm).not.toHaveBeenCalled();
  });

  it('returns the response before the prewarm finishes', async () => {
    let finish: () => void = () => undefined;
    const prewarmer = { prewarm: vi.fn().mockImplementation(() => new Promise<void>((r) => { finish = r; })) };
    const response = await service(prewarmer).processCheckIn(userId, input);
    expect(response.coach_note).toBe('Nice.');
    await vi.waitFor(() => expect(prewarmer.prewarm).toHaveBeenCalled());
    finish();
  });

  it('swallows a rejected prewarm and a synchronous throw', async () => {
    const rejecting = { prewarm: vi.fn().mockRejectedValue(new Error('boom')) };
    const response = await service(rejecting).processCheckIn(userId, input);
    expect(response.coach_note).toBe('Nice.');
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith('recipe_prewarm_failed', expect.objectContaining({ slot_id: 1 })));

    repository.clear();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    const throwing = { prewarm: vi.fn().mockImplementation(() => { throw new Error('sync'); }) };
    await expect(service(throwing).processCheckIn(userId, input)).resolves.toMatchObject({ coach_note: 'Nice.' });
  });

  it('works with no prewarmer (disabled)', async () => {
    await expect(service(null).processCheckIn(userId, input)).resolves.toMatchObject({ coach_note: 'Nice.' });
  });
});
