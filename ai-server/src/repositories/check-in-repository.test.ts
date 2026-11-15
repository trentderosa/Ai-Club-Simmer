import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInIdempotencyConflict } from '../types/check-in.js';
import { InMemoryCheckInRepository } from './in-memory-check-in-repository.js';

describe('InMemoryCheckInRepository', () => {
  let repository: InMemoryCheckInRepository;
  const testUserId = randomUUID();
  const testUser2Id = randomUUID();
  let testRecipeId: string;
  const testSlotId = 1;

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    testRecipeId = randomUUID();
    repository.seedUserRecipe({
      id: testRecipeId,
      user_id: testUserId,
      slot_id: testSlotId,
    });
  });

  describe('validateUserRecipe', () => {
    it('returns true for valid recipe owned by user', async () => {
      const result = await repository.validateUserRecipe(testUserId, testRecipeId, testSlotId);
      expect(result).toBe(true);
    });

    it('returns false for non-existent recipe', async () => {
      const result = await repository.validateUserRecipe(testUserId, randomUUID(), testSlotId);
      expect(result).toBe(false);
    });

    it('returns false for recipe owned by different user', async () => {
      const result = await repository.validateUserRecipe(testUser2Id, testRecipeId, testSlotId);
      expect(result).toBe(false);
    });

    it('returns false for mismatched slot_id', async () => {
      const result = await repository.validateUserRecipe(testUserId, testRecipeId, 2);
      expect(result).toBe(false);
    });
  });

  describe('create', () => {
    it('creates check-in with all fields', async () => {
      const checkIn = await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'Sauce was good',
        was_hard: 'Timing was tricky',
      });

      expect(checkIn.id).toBeDefined();
      expect(checkIn.user_id).toBe(testUserId);
      expect(checkIn.user_recipe_id).toBe(testRecipeId);
      expect(checkIn.slot_id).toBe(testSlotId);
      expect(checkIn.difficulty_rating).toBe('ok');
      expect(checkIn.went_well).toBe('Sauce was good');
      expect(checkIn.was_hard).toBe('Timing was tricky');
      expect(checkIn.is_repeat).toBe(false);
      expect(checkIn.created_at).toBeInstanceOf(Date);
    });

    it('creates check-in with null optional fields', async () => {
      const checkIn = await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'easy',
        went_well: null,
        was_hard: null,
      });

      expect(checkIn.went_well).toBeNull();
      expect(checkIn.was_hard).toBeNull();
    });

    it('throws for invalid recipe ownership', async () => {
      await expect(
        repository.create({
          user_id: testUser2Id,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
        })
      ).rejects.toThrow('Invalid user_recipe_id or slot_id mismatch');
    });
  });

    it('reuses a supplied id and returns the first write on replay', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const first = await repository.create({
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'first',
        was_hard: null,
      });
      const replay = await repository.create({
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: 'retry',
        was_hard: 'ignored',
      });

      expect(first.id).toBe(id);
      expect(first.created).toBe(true);
      expect(replay.id).toBe(id);
      expect(replay.created).toBe(false);
      expect(replay.went_well).toBe('first');
      expect(replay.difficulty_rating).toBe('ok');
      expect(repository.getAllCheckIns()).toHaveLength(1);
    });

    it('rejects a supplied id that already belongs to a different check-in', async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      await repository.create({
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: null,
        was_hard: null,
      });

      const otherRecipe = '33333333-3333-4333-8333-333333333333';
      repository.seedUserRecipe({ id: otherRecipe, user_id: testUserId, slot_id: 2 });

      await expect(
        repository.create({
          id,
          user_id: testUserId,
          user_recipe_id: otherRecipe,
          slot_id: 2,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
        })
      ).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
      expect(repository.getAllCheckIns()).toHaveLength(1);
    });

  describe('getById', () => {
    it('returns check-in for owner', async () => {
      const created = await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: null,
        was_hard: null,
      });

      const found = await repository.getById(created.id, testUserId);
      expect(found).toMatchObject({
        id: created.id,
        user_id: testUserId,
        difficulty_rating: 'hard',
      });
    });

    it('returns null for different user', async () => {
      const created = await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: null,
        was_hard: null,
      });

      const found = await repository.getById(created.id, testUser2Id);
      expect(found).toBeNull();
    });

    it('returns null for non-existent id', async () => {
      const found = await repository.getById(randomUUID(), testUserId);
      expect(found).toBeNull();
    });
  });

  describe('getRecentByUser', () => {
    it('returns check-ins ordered by created_at desc', async () => {
      await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'easy',
        went_well: 'first',
        was_hard: null,
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));

      await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: 'second',
        was_hard: null,
      });

      const recent = await repository.getRecentByUser(testUserId, 5);
      expect(recent).toHaveLength(2);
      expect(recent[0].went_well).toBe('second');
      expect(recent[1].went_well).toBe('first');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await repository.create({
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
        });
      }

      const recent = await repository.getRecentByUser(testUserId, 3);
      expect(recent).toHaveLength(3);
    });

    it('returns empty array for user with no check-ins', async () => {
      const recent = await repository.getRecentByUser(testUser2Id);
      expect(recent).toEqual([]);
    });
  });

  describe('cross-user isolation', () => {
    it('users have separate check-in records', async () => {
      const user2RecipeId = randomUUID();
      repository.seedUserRecipe({
        id: user2RecipeId,
        user_id: testUser2Id,
        slot_id: testSlotId,
      });

      await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'easy',
        went_well: null,
        was_hard: null,
      });

      await repository.create({
        user_id: testUser2Id,
        user_recipe_id: user2RecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: null,
        was_hard: null,
      });

      const user1CheckIns = await repository.getRecentByUser(testUserId);
      const user2CheckIns = await repository.getRecentByUser(testUser2Id);

      expect(user1CheckIns).toHaveLength(1);
      expect(user1CheckIns[0].difficulty_rating).toBe('easy');

      expect(user2CheckIns).toHaveLength(1);
      expect(user2CheckIns[0].difficulty_rating).toBe('hard');
    });
  });
});
