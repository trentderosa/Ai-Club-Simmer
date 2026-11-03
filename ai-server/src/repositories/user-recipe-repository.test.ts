import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryUserRecipeRepository } from './user-recipe-repository.js';
import type { Recipe } from '../schemas/recipe.js';

const testRecipe: Recipe = {
  title: 'Test Recipe',
  ingredients: [{ name: 'ingredient', amount: '1 cup' }],
  timeEstimateMinutes: 30,
  steps: [{ instruction: 'Test step', isSafetyStep: false }],
};

const anotherRecipe: Recipe = {
  title: 'Another Recipe',
  ingredients: [{ name: 'flour', amount: '2 cups' }],
  timeEstimateMinutes: 45,
  steps: [{ instruction: 'Mix', isSafetyStep: false }],
};

describe('InMemoryUserRecipeRepository', () => {
  let repo: InMemoryUserRecipeRepository;

  beforeEach(() => {
    repo = new InMemoryUserRecipeRepository();
  });

  describe('findByUserAndSlot', () => {
    it('returns null when no recipe exists', async () => {
      const result = await repo.findByUserAndSlot('user-1', 1);
      expect(result).toBeNull();
    });

    it('returns the saved recipe when it exists', async () => {
      await repo.save('user-1', 1, testRecipe);

      const result = await repo.findByUserAndSlot('user-1', 1);

      expect(result).not.toBeNull();
      expect(result?.recipe).toEqual(testRecipe);
      expect(result?.userId).toBe('user-1');
      expect(result?.slotId).toBe(1);
    });

    it('returns null for different user', async () => {
      await repo.save('user-1', 1, testRecipe);

      const result = await repo.findByUserAndSlot('user-2', 1);

      expect(result).toBeNull();
    });

    it('returns null for different slot', async () => {
      await repo.save('user-1', 1, testRecipe);

      const result = await repo.findByUserAndSlot('user-1', 2);

      expect(result).toBeNull();
    });
  });

  describe('save', () => {
    it('saves and returns the recipe', async () => {
      const saved = await repo.save('user-1', 1, testRecipe);

      expect(saved.recipe).toEqual(testRecipe);
      expect(saved.userId).toBe('user-1');
      expect(saved.slotId).toBe(1);
      expect(saved.id).toBeDefined();
      expect(saved.createdAt).toBeInstanceOf(Date);
    });

    it('returns existing recipe on duplicate save', async () => {
      const first = await repo.save('user-1', 1, testRecipe);
      const second = await repo.save('user-1', 1, anotherRecipe);

      expect(second.id).toBe(first.id);
      expect(second.recipe).toEqual(testRecipe);
    });

    it('allows different slots for same user', async () => {
      const slot1 = await repo.save('user-1', 1, testRecipe);
      const slot2 = await repo.save('user-1', 2, anotherRecipe);

      expect(slot1.id).not.toBe(slot2.id);
      expect(slot1.recipe.title).toBe('Test Recipe');
      expect(slot2.recipe.title).toBe('Another Recipe');
    });

    it('allows same slot for different users', async () => {
      const user1 = await repo.save('user-1', 1, testRecipe);
      const user2 = await repo.save('user-2', 1, anotherRecipe);

      expect(user1.id).not.toBe(user2.id);
      expect(user1.recipe.title).toBe('Test Recipe');
      expect(user2.recipe.title).toBe('Another Recipe');
    });
  });

  describe('concurrent saves', () => {
    it('produces exactly one row for concurrent first requests', async () => {
      const promises = Array.from({ length: 10 }, () =>
        repo.save('user-1', 1, testRecipe)
      );

      const results = await Promise.all(promises);

      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(1);

      const all = repo.getAll();
      expect(all.length).toBe(1);
    });

    it('all concurrent saves return the same recipe', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        repo.save('user-1', 1, {
          ...testRecipe,
          title: `Recipe Attempt ${i}`,
        })
      );

      const results = await Promise.all(promises);

      const titles = results.map((r) => r.recipe.title);
      const uniqueTitles = new Set(titles);
      expect(uniqueTitles.size).toBe(1);
    });
  });

  describe('cross-user isolation', () => {
    it('user A cannot see user B recipes', async () => {
      await repo.save('user-a', 1, testRecipe);
      await repo.save('user-b', 1, anotherRecipe);

      const userARecipe = await repo.findByUserAndSlot('user-a', 1);
      const userBRecipe = await repo.findByUserAndSlot('user-b', 1);

      expect(userARecipe?.recipe.title).toBe('Test Recipe');
      expect(userBRecipe?.recipe.title).toBe('Another Recipe');
    });
  });

  describe('clear', () => {
    it('removes all recipes', async () => {
      await repo.save('user-1', 1, testRecipe);
      await repo.save('user-2', 2, anotherRecipe);

      repo.clear();

      expect(repo.getAll()).toHaveLength(0);
      expect(await repo.findByUserAndSlot('user-1', 1)).toBeNull();
    });
  });
});
