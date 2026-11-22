import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInIdempotencyConflict, CheckInMasterySessionError } from '../types/check-in.js';
import { InMemoryCheckInRepository } from './in-memory-check-in-repository.js';
import { InMemoryGeneratedCheckInRepository } from './generated-check-in-repository.js';

describe('InMemoryCheckInRepository', () => {
  let repo: InMemoryCheckInRepository;
  const userId = 'user-1';
  const recipeId = 'recipe-1';
  const params = {
    user_id: userId,
    user_recipe_id: recipeId,
    slot_id: 1,
    difficulty_rating: 'ok' as const,
    went_well: 'Good',
    was_hard: null,
  };

  beforeEach(() => {
    repo = new InMemoryCheckInRepository();
    repo.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
  });

  it('validateUserRecipe requires matching owner and slot', async () => {
    expect(await repo.validateUserRecipe(userId, recipeId, 1)).toBe(true);
    expect(await repo.validateUserRecipe('user-2', recipeId, 1)).toBe(false);
    expect(await repo.validateUserRecipe(userId, recipeId, 2)).toBe(false);
    expect(await repo.validateUserRecipe(userId, 'missing', 1)).toBe(false);
  });

  it('rejects a check-in for an invalid recipe', async () => {
    await expect(repo.create({ ...params, user_recipe_id: 'missing' })).rejects.toThrow(
      'Invalid user_recipe_id or slot_id mismatch'
    );
  });

  it('creates a check-in with created: true and is_repeat false', async () => {
    const result = await repo.create(params);

    expect(result.created).toBe(true);
    expect(result.is_repeat).toBe(false);
    expect(await repo.getById(result.id, userId)).toMatchObject({ id: result.id, went_well: 'Good' });
  });

  it('same client id replays return the existing check-in with created: false', async () => {
    const id = randomUUID();
    const first = await repo.create({ ...params, id });
    const replay = await repo.create({ ...params, id, went_well: 'changed' });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.went_well).toBe('Good');
    expect(repo.getAllCheckIns()).toHaveLength(1);
  });

  it('reusing an id for a different user or recipe is an idempotency conflict', async () => {
    const id = randomUUID();
    await repo.create({ ...params, id });
    repo.seedUserRecipe({ id: 'recipe-2', user_id: userId, slot_id: 1 });
    repo.seedUserRecipe({ id: 'recipe-3', user_id: 'user-2', slot_id: 1 });

    await expect(repo.create({ ...params, id, user_recipe_id: 'recipe-2' })).rejects.toBeInstanceOf(
      CheckInIdempotencyConflict
    );
    await expect(
      repo.create({ ...params, id, user_id: 'user-2', user_recipe_id: 'recipe-3' })
    ).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
  });

  it('allows one check-in per mastery session', async () => {
    const sessionId = randomUUID();
    const first = await repo.create({ ...params, mastery_session_id: sessionId });

    expect(repo.checkInForMasterySession(sessionId)).toBe(first.id);
    const err = await repo.create({ ...params, mastery_session_id: sessionId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckInMasterySessionError);
    expect((err as CheckInMasterySessionError).code).toBe('MASTERY_SESSION_USED');
    expect(repo.checkInForMasterySession('unknown')).toBeNull();
  });

  it('getById is scoped to the owner', async () => {
    const created = await repo.create(params);

    expect(await repo.getById(created.id, 'user-2')).toBeNull();
    expect(await repo.getById('missing', userId)).toBeNull();
  });

  it('getRecentByUser returns newest first, owner only, respecting the limit', async () => {
    const older = await repo.create(params);
    const newer = await repo.create(params);
    // Force deterministic ordering regardless of clock resolution.
    repo.getAllCheckIns().find((c) => c.id === older.id)!.created_at = new Date('2026-11-01T00:00:00Z');
    repo.getAllCheckIns().find((c) => c.id === newer.id)!.created_at = new Date('2026-11-02T00:00:00Z');
    repo.seedUserRecipe({ id: 'recipe-x', user_id: 'user-2', slot_id: 1 });
    await repo.create({ ...params, user_id: 'user-2', user_recipe_id: 'recipe-x' });

    const recent = await repo.getRecentByUser(userId);
    expect(recent.map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(await repo.getRecentByUser(userId, 1)).toHaveLength(1);
  });

  it('clear removes all data', async () => {
    await repo.create(params);
    repo.clear();

    expect(repo.getAllCheckIns()).toHaveLength(0);
    expect(await repo.validateUserRecipe(userId, recipeId, 1)).toBe(false);
  });
});

describe('InMemoryGeneratedCheckInRepository', () => {
  let repo: InMemoryGeneratedCheckInRepository;
  const params = {
    user_id: 'user-1',
    generated_recipe_id: 'gen-1',
    difficulty_rating: 'easy' as const,
    went_well: 'Nice',
    was_hard: null,
  };

  beforeEach(() => {
    repo = new InMemoryGeneratedCheckInRepository();
    repo.seedRecipe('user-1', 'gen-1', 'Spaghetti Carbonara');
  });

  it('validates recipes per owner and returns the dish name', async () => {
    expect(await repo.validateRecipe('user-1', 'gen-1')).toBe(true);
    expect(await repo.validateRecipe('user-2', 'gen-1')).toBe(false);
    expect(await repo.getDishName('user-1', 'gen-1')).toBe('Spaghetti Carbonara');
    expect(await repo.getDishName('user-2', 'gen-1')).toBeNull();
  });

  it('rejects an unknown recipe', async () => {
    await expect(repo.create({ ...params, user_id: 'user-2' })).rejects.toThrow('Invalid generated_recipe_id');
  });

  it('creates, then replays the same id as created: false', async () => {
    const id = randomUUID();
    const first = await repo.create({ ...params, id });
    const replay = await repo.create({ ...params, id, went_well: 'changed' });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.went_well).toBe('Nice');
  });

  it('reusing an id for another user or recipe is an idempotency conflict', async () => {
    const id = randomUUID();
    await repo.create({ ...params, id });
    repo.seedRecipe('user-1', 'gen-2');
    repo.seedRecipe('user-2', 'gen-1');

    await expect(repo.create({ ...params, id, generated_recipe_id: 'gen-2' })).rejects.toBeInstanceOf(
      CheckInIdempotencyConflict
    );
    await expect(repo.create({ ...params, id, user_id: 'user-2' })).rejects.toBeInstanceOf(
      CheckInIdempotencyConflict
    );
  });
});
