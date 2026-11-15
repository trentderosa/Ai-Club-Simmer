import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { randomUUID } from 'crypto';
import { createCheckInRouter } from './check-in.js';
import { CheckInService } from '../services/check-in-service.js';
import { InMemoryCheckInRepository } from '../repositories/in-memory-check-in-repository.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';
import type { CoachNoteGenerator } from '../services/coach-note.js';
import type { PathRepository } from '../repositories/path-repository.js';

/**
 * F6 repeat suggestion, F8 mastery reveal counts and F9 badges on
 * POST /api/check-ins.
 */

const USER_ID = randomUUID();

type PathLookups = Pick<PathRepository, 'getPathSlot' | 'badgesEarnedBy'>;

function setup(pathRepository: PathLookups | null): {
  app: express.Express;
  repository: InMemoryCheckInRepository;
  logger: { error: ReturnType<typeof vi.fn> };
  recipeFor: (slotId: number) => string;
} {
  const repository = new InMemoryCheckInRepository();
  const jwtVerifier: JwtVerifier = { verify: vi.fn().mockResolvedValue({ valid: true, userId: USER_ID }) };
  const coach: CoachNoteGenerator = { generate: vi.fn().mockResolvedValue({ note: 'Nice work.' }) };
  const logger = { error: vi.fn() };
  const service = new CheckInService(repository, coach, null, logger, { pathRepository });
  const app = express();
  app.use(express.json());
  app.use('/api/check-ins', createCheckInRouter({ checkInService: service, jwtVerifier }, { rateLimit: { windowMs: 60000, maxRequests: 100 } }));
  const recipeFor = (slotId: number): string => {
    const id = randomUUID();
    repository.seedUserRecipe({ id, user_id: USER_ID, slot_id: slotId });
    return id;
  };
  return { app, repository, logger, recipeFor };
}

function lookups(overrides: Partial<PathLookups> = {}): PathLookups {
  return {
    getPathSlot: vi.fn().mockImplementation((id: number) =>
      Promise.resolve({ id, dishName: `Dish ${id}`, techniqueFocus: 't', isFinal: id === 10 })
    ),
    badgesEarnedBy: vi.fn().mockResolvedValue([
      { code: 'complete_slot_1', name: 'Knife Basics Salad', description: 'Cooked it.', kind: 'completion' },
    ]),
    ...overrides,
  };
}

function post(app: express.Express, body: Record<string, unknown>): request.Test {
  return request(app).post('/api/check-ins').set('Authorization', 'Bearer t').send(body);
}

describe('F6 suggest_repeat', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(lookups());
  });

  it('is true only when the session was rated hard', async () => {
    for (const [rating, expected] of [['hard', true], ['ok', false], ['easy', false]] as const) {
      const res = await post(ctx.app, { user_recipe_id: ctx.recipeFor(1), slot_id: 1, rating });
      expect(res.status).toBe(201);
      expect(res.body.suggest_repeat).toBe(expected);
    }
  });
});

describe('F9 badges in the check-in response', () => {
  it('lists the badges this check-in earned', async () => {
    const path = lookups();
    const { app, recipeFor } = setup(path);
    const res = await post(app, { user_recipe_id: recipeFor(1), slot_id: 1, rating: 'ok' });
    expect(res.body.badges).toEqual({
      status: 'ok',
      earned: [{ code: 'complete_slot_1', name: 'Knife Basics Salad', description: 'Cooked it.', kind: 'completion' }],
    });
    expect(path.badgesEarnedBy).toHaveBeenCalledWith(res.body.check_in_id);
  });

  it('a failed lookup keeps the check-in and reports failed', async () => {
    const { app, repository, logger, recipeFor } = setup(
      lookups({ badgesEarnedBy: vi.fn().mockRejectedValue(new Error('timeout')) })
    );
    const res = await post(app, { user_recipe_id: recipeFor(1), slot_id: 1, rating: 'ok' });
    expect(res.status).toBe(201);
    expect(res.body.badges).toEqual({ status: 'failed' });
    expect(await repository.getById(res.body.check_in_id as string, USER_ID)).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith('badge_lookup_failed', expect.objectContaining({ error: 'timeout' }));
  });

  it('without a path repository (dev) badges are skipped', async () => {
    const { app, recipeFor } = setup(null);
    const res = await post(app, { user_recipe_id: recipeFor(1), slot_id: 1, rating: 'ok' });
    expect(res.body.badges).toEqual({ status: 'skipped' });
  });
});

describe('F8 mastery reveal counts', () => {
  it('accepted on the final slot', async () => {
    const { app, recipeFor } = setup(lookups());
    const res = await post(app, {
      user_recipe_id: recipeFor(10),
      slot_id: 10,
      rating: 'ok',
      mastery: { hidden_steps: 4, revealed_steps: 1 },
    });
    expect(res.status).toBe(201);
  });

  it('rejected with MASTERY_NOT_ALLOWED on any other slot', async () => {
    const { app, repository, recipeFor } = setup(lookups());
    const res = await post(app, {
      user_recipe_id: recipeFor(3),
      slot_id: 3,
      rating: 'ok',
      mastery: { hidden_steps: 4, revealed_steps: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MASTERY_NOT_ALLOWED');
    expect(await repository.getRecentByUser(USER_ID)).toEqual([]);
  });

  it('revealed_steps cannot exceed hidden_steps', async () => {
    const { app, recipeFor } = setup(lookups());
    const res = await post(app, {
      user_recipe_id: recipeFor(10),
      slot_id: 10,
      rating: 'ok',
      mastery: { hidden_steps: 2, revealed_steps: 3 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
