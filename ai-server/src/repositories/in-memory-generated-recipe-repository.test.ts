import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryGeneratedRecipeRepository } from './in-memory-generated-recipe-repository.js';
import type { SaveGeneratedRecipeInput } from './generated-recipe-repository.js';
import type { DishPhoto } from '../services/dish-photo.js';

const input: SaveGeneratedRecipeInput = {
  userId: 'user-1',
  dishQuery: 'Spaghetti Carbonara!',
  normalizedDishName: 'spaghetti carbonara',
  recipe: {
    title: 'Carbonara',
    ingredients: [{ name: 'spaghetti', amount: '200 g' }],
    timeEstimateMinutes: 30,
    steps: [{ instruction: 'Boil', isSafetyStep: false }],
  },
  stepCount: 1,
  ingredientCount: 1,
  timeEstimateMinutes: 30,
  xpValue: 25,
};

const photo: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Carbonara.jpg',
  credit: {
    author: 'Fake Author',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Carbonara.jpg',
  },
};

describe('InMemoryGeneratedRecipeRepository', () => {
  let repo: InMemoryGeneratedRecipeRepository;

  beforeEach(() => {
    repo = new InMemoryGeneratedRecipeRepository();
  });

  it('returns null for unknown lookups', async () => {
    expect(await repo.findByUserAndNormalizedName('user-1', 'nothing')).toBeNull();
    expect(await repo.findByIdForUser('user-1', 'missing-id')).toBeNull();
  });

  it('saves and finds by normalized name and by id', async () => {
    const saved = await repo.save(input);

    expect(saved).toMatchObject({
      userId: 'user-1',
      dishQuery: 'Spaghetti Carbonara!',
      normalizedDishName: 'spaghetti carbonara',
      videos: null,
      photo: null,
      xpValue: 25,
    });
    expect(await repo.findByUserAndNormalizedName('user-1', 'spaghetti carbonara')).toBe(saved);
    expect(await repo.findByIdForUser('user-1', saved.id)).toBe(saved);
  });

  it('first saved recipe wins for the same user and dish (counts and xp stay frozen)', async () => {
    const first = await repo.save(input);
    const second = await repo.save({ ...input, xpValue: 99, stepCount: 9 });

    expect(second).toBe(first);
    expect(second.xpValue).toBe(25);
    expect(second.stepCount).toBe(1);
  });

  it('concurrent saves share one row', async () => {
    const [a, b, c] = await Promise.all([repo.save(input), repo.save(input), repo.save(input)]);

    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
  });

  it('a find during an in-flight save waits for the saved row', async () => {
    const savePromise = repo.save(input);
    const found = await repo.findByUserAndNormalizedName('user-1', 'spaghetti carbonara');

    expect(found?.id).toBe((await savePromise).id);
  });

  it('keeps recipes separate per user and per dish', async () => {
    const a = await repo.save(input);
    const otherUser = await repo.save({ ...input, userId: 'user-2' });
    const otherDish = await repo.save({ ...input, normalizedDishName: 'pad thai' });

    expect(new Set([a.id, otherUser.id, otherDish.id]).size).toBe(3);
    expect(await repo.findByUserAndNormalizedName('user-2', 'pad thai')).toBeNull();
  });

  it("findByIdForUser does not return another user's recipe", async () => {
    const saved = await repo.save(input);

    expect(await repo.findByIdForUser('user-2', saved.id)).toBeNull();
  });

  it('saveVideos and savePhoto update the owner row only', async () => {
    const saved = await repo.save(input);
    const videos = { Boil: { videoId: 'abc123' } };

    await repo.saveVideos('user-2', saved.id, videos);
    await repo.savePhoto('user-2', saved.id, photo);
    expect((await repo.findByIdForUser('user-1', saved.id))?.videos).toBeNull();
    expect((await repo.findByIdForUser('user-1', saved.id))?.photo).toBeNull();

    await repo.saveVideos('user-1', saved.id, videos);
    await repo.savePhoto('user-1', saved.id, photo);
    const after = await repo.findByIdForUser('user-1', saved.id);
    expect(after?.videos).toEqual(videos);
    expect(after?.photo).toEqual(photo);
  });

  it('saveVideos and savePhoto are no-ops for an unknown id', async () => {
    await expect(repo.saveVideos('user-1', 'missing', {})).resolves.toBeUndefined();
    await expect(repo.savePhoto('user-1', 'missing', photo)).resolves.toBeUndefined();
  });
});
