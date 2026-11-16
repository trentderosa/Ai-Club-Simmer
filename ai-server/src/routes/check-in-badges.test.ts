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
 * F6 repeat suggestion, F8 mastery sessions and F9 badges on
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

describe('F8 mastery sessions on the check-in', () => {
  const sessionId = randomUUID();

  it('mastery_session_id is accepted on the final slot and linked to the check-in', async () => {
    const { app, repository, recipeFor } = setup(lookups());
    const res = await post(app, { user_recipe_id: recipeFor(10), slot_id: 10, rating: 'ok', mastery_session_id: sessionId });
    expect(res.status).toBe(201);
    expect(repository.checkInForMasterySession(sessionId)).toBe(res.body.check_in_id);
  });

  it('rejected with MASTERY_NOT_ALLOWED on any other slot', async () => {
    const { app, repository, recipeFor } = setup(lookups());
    const res = await post(app, { user_recipe_id: recipeFor(3), slot_id: 3, rating: 'ok', mastery_session_id: sessionId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MASTERY_NOT_ALLOWED');
    expect(await repository.getRecentByUser(USER_ID)).toEqual([]);
  });

  it('a session backs one check-in: reusing it is 409 MASTERY_SESSION_USED', async () => {
    const { app, recipeFor } = setup(lookups());
    const recipe = recipeFor(10);
    const first = await post(app, { user_recipe_id: recipe, slot_id: 10, rating: 'ok', mastery_session_id: sessionId });
    expect(first.status).toBe(201);
    const second = await post(app, { user_recipe_id: recipe, slot_id: 10, rating: 'ok', mastery_session_id: sessionId });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('MASTERY_SESSION_USED');
  });

  it('a retry of the same attempt (same idempotency_key) is a replay, not a reuse', async () => {
    const { app, recipeFor } = setup(lookups());
    const body = { user_recipe_id: recipeFor(10), slot_id: 10, rating: 'ok', mastery_session_id: randomUUID(), idempotency_key: randomUUID() };
    const first = await post(app, body);
    const retry = await post(app, body);
    expect(retry.status).toBe(201);
    expect(retry.body.check_in_id).toBe(first.body.check_in_id);
  });

  it('must be a UUID', async () => {
    const { app, recipeFor } = setup(lookups());
    const res = await post(app, { user_recipe_id: recipeFor(10), slot_id: 10, rating: 'ok', mastery_session_id: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('is not allowed on a cook-anything check-in', async () => {
    const { app } = setup(lookups());
    const res = await post(app, { generated_recipe_id: randomUUID(), rating: 'ok', mastery_session_id: sessionId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('deprecated client counts are still accepted on the final slot but never stored', async () => {
    const { app, repository, recipeFor } = setup(lookups());
    const res = await post(app, {
      user_recipe_id: recipeFor(10),
      slot_id: 10,
      rating: 'ok',
      mastery: { hidden_steps: 4, revealed_steps: 0 },
    });
    expect(res.status).toBe(201);
    const [saved] = repository.getAllCheckIns();
    expect(saved).not.toHaveProperty('hidden_steps');
    expect(saved).not.toHaveProperty('revealed_steps');
  });

  it('deprecated client counts on any other slot are still MASTERY_NOT_ALLOWED', async () => {
    const { app, recipeFor } = setup(lookups());
    const res = await post(app, { user_recipe_id: recipeFor(3), slot_id: 3, rating: 'ok', mastery: { hidden_steps: 4, revealed_steps: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MASTERY_NOT_ALLOWED');
  });
});
