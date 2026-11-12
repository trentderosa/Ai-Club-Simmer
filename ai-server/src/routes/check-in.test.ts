import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { randomUUID } from 'crypto';
import { createCheckInRouter } from './check-in.js';
import { CheckInService } from '../services/check-in-service.js';
import { InMemoryCheckInRepository } from '../repositories/in-memory-check-in-repository.js';
import type { JwtVerifier, JwtVerifyResult } from '../services/jwt-verifier.js';
import type { CoachNoteGenerator } from '../services/coach-note.js';
import { FALLBACK_NOTE } from '../services/coach-note.js';
import type { XpAwarder } from '../services/xp-awarder.js';

function createMockJwtVerifier(defaultResult: JwtVerifyResult): JwtVerifier {
  return {
    verify: vi.fn().mockResolvedValue(defaultResult),
  };
}

function createMockCoachNoteGenerator(): CoachNoteGenerator {
  return {
    generate: vi.fn().mockResolvedValue({
      note: 'Great job! Keep practicing your knife skills.',
      focus_area: 'knife skills',
    }),
  };
}

describe('Check-in API (F6)', () => {
  let app: express.Express;
  let repository: InMemoryCheckInRepository;
  let jwtVerifier: JwtVerifier;
  let coachNoteGenerator: CoachNoteGenerator;
  const testUserId = randomUUID();
  const testUser2Id = randomUUID();
  let testRecipeId: string;
  const testSlotId = 1;

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    jwtVerifier = createMockJwtVerifier({ valid: true, userId: testUserId });
    coachNoteGenerator = createMockCoachNoteGenerator();
    const service = new CheckInService(repository, coachNoteGenerator);
    
    app = express();
    app.use(express.json());
    app.use('/api/check-ins', createCheckInRouter(
      { checkInService: service, jwtVerifier },
      { rateLimit: { windowMs: 60000, maxRequests: 100 } }
    ));

    testRecipeId = randomUUID();
    repository.seedUserRecipe({
      id: testRecipeId,
      user_id: testUserId,
      slot_id: testSlotId,
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Missing or invalid authorization header');
    });

    it('returns 401 when Authorization header format is invalid', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'InvalidFormat')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Missing or invalid authorization header');
    });

    it('returns 401 when token is invalid', async () => {
      (jwtVerifier.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        valid: false,
        error: 'invalid_token',
      });

      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer invalid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('returns 401 when token is expired', async () => {
      (jwtVerifier.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        valid: false,
        error: 'expired',
      });

      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer expired-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Token expired');
    });

    it('returns 503 when auth service is unavailable', async () => {
      (jwtVerifier.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        valid: false,
        error: 'service_unavailable',
      });

      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer some-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Authentication service unavailable');
    });

    it('accepts valid JWT and creates check-in', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(201);
      expect(response.body.check_in_id).toBeDefined();
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when user_recipe_id is missing', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when slot_id is out of range', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: 11,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when rating is invalid', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'very_hard',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when went_well exceeds 500 characters', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
          went_well: 'a'.repeat(501),
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when user_recipe_id does not exist', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: randomUUID(),
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECIPE');
    });
  });

  describe('Successful check-in', () => {
    it('creates check-in with minimal fields', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        check_in_id: expect.any(String),
        coach_note: expect.any(String),
      });
    });

    it('creates check-in with all optional fields', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'hard',
          went_well: 'The sauce turned out great',
          was_hard: 'Timing the pasta was tricky',
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        check_in_id: expect.any(String),
        coach_note: expect.any(String),
        focus_area: expect.any(String),
      });
    });

    it('persists check-in to repository', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
          went_well: 'It worked',
        });

      expect(response.status).toBe(201);

      const checkIns = repository.getAllCheckIns();
      expect(checkIns).toHaveLength(1);
      expect(checkIns[0]).toMatchObject({
        id: response.body.check_in_id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'It worked',
      });
    });
  });

  describe('Cross-user isolation', () => {
    it('user cannot create check-in for another user recipe', async () => {
      const user2RecipeId = randomUUID();
      repository.seedUserRecipe({
        id: user2RecipeId,
        user_id: testUser2Id,
        slot_id: testSlotId,
      });

      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: user2RecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECIPE');
    });
  });

  describe('S4: generateCoachNote not called on validation failure', () => {
    it('does not call coach note generator when recipe validation fails', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: randomUUID(),
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(coachNoteGenerator.generate).not.toHaveBeenCalled();
    });

    it('does not call coach note generator when input validation fails', async () => {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer valid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'invalid_rating',
        });

      expect(response.status).toBe(400);
      expect(coachNoteGenerator.generate).not.toHaveBeenCalled();
    });
  });
});

describe('B3: Per-user rate limiting', () => {
  it('user A hitting limit does not 429 user B', async () => {
    const userAId = randomUUID();
    const userBId = randomUUID();
    
    // Create separate verifier that returns different users based on token
    const multiUserVerifier: JwtVerifier = {
      verify: vi.fn().mockImplementation((token: string) => {
        if (token === 'user-a-token') {
          return Promise.resolve({ valid: true, userId: userAId });
        } else if (token === 'user-b-token') {
          return Promise.resolve({ valid: true, userId: userBId });
        }
        return Promise.resolve({ valid: false, error: 'invalid_token' as const });
      }),
    };

    const repository = new InMemoryCheckInRepository();
    const coachNoteGenerator: CoachNoteGenerator = {
      generate: vi.fn().mockResolvedValue({
        note: 'Great job!',
        focus_area: 'basics',
      }),
    };
    const service = new CheckInService(repository, coachNoteGenerator);

    const app = express();
    app.use(express.json());
    app.use('/api/check-ins', createCheckInRouter(
      { checkInService: service, jwtVerifier: multiUserVerifier },
      { rateLimit: { windowMs: 60000, maxRequests: 2 } } // Low limit for testing
    ));

    // Seed recipes for both users
    const userARecipeId = randomUUID();
    const userBRecipeId = randomUUID();
    repository.seedUserRecipe({ id: userARecipeId, user_id: userAId, slot_id: 1 });
    repository.seedUserRecipe({ id: userBRecipeId, user_id: userBId, slot_id: 1 });

    // User A makes 2 requests (hits the limit)
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer user-a-token')
        .send({ user_recipe_id: userARecipeId, slot_id: 1, rating: 'ok' });
    }

    // User A's 3rd request should be rate limited
    const userALimitedResponse = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer user-a-token')
      .send({ user_recipe_id: userARecipeId, slot_id: 1, rating: 'ok' });
    
    expect(userALimitedResponse.status).toBe(429);

    // User B should NOT be rate limited
    const userBResponse = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer user-b-token')
      .send({ user_recipe_id: userBRecipeId, slot_id: 1, rating: 'ok' });

    expect(userBResponse.status).toBe(201);
  });

  it('401 requests do not consume rate limit budget', async () => {
    const userId = randomUUID();
    
    // Verifier that rejects invalid tokens
    const jwtVerifier: JwtVerifier = {
      verify: vi.fn().mockImplementation((token: string) => {
        if (token === 'valid-token') {
          return Promise.resolve({ valid: true, userId });
        }
        return Promise.resolve({ valid: false, error: 'invalid_token' as const });
      }),
    };

    const repository = new InMemoryCheckInRepository();
    const coachNoteGenerator: CoachNoteGenerator = {
      generate: vi.fn().mockResolvedValue({ note: 'Great!', focus_area: 'test' }),
    };
    const service = new CheckInService(repository, coachNoteGenerator);

    const app = express();
    app.use(express.json());
    app.use('/api/check-ins', createCheckInRouter(
      { checkInService: service, jwtVerifier },
      { rateLimit: { windowMs: 60000, maxRequests: 2 } }
    ));

    const recipeId = randomUUID();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });

    // Send many invalid auth requests (should all get 401, not 429)
    for (let i = 0; i < 10; i++) {
      const response = await request(app)
        .post('/api/check-ins')
        .set('Authorization', 'Bearer invalid-token')
        .send({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' });
      
      // Should always be 401, never 429
      expect(response.status).toBe(401);
    }

    // Valid user should still have full budget
    const response1 = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer valid-token')
      .send({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' });
    expect(response1.status).toBe(201);

    const response2 = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer valid-token')
      .send({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' });
    expect(response2.status).toBe(201);
  });
});

describe('Coach Note Generation Fallback', () => {
  it('FALLBACK_NOTE is defined and has required fields', () => {
    expect(FALLBACK_NOTE).toBeDefined();
    expect(FALLBACK_NOTE.note).toBeDefined();
    expect(typeof FALLBACK_NOTE.note).toBe('string');
    expect(FALLBACK_NOTE.note.length).toBeGreaterThan(0);
  });
});

describe('Check-in API XP award (service role)', () => {
  const userId = randomUUID();
  const recipeId = randomUUID();

  function buildApp(award: XpAwarder['award']): {
    app: express.Express;
    repository: InMemoryCheckInRepository;
  } {
    const repository = new InMemoryCheckInRepository();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    const service = new CheckInService(
      repository,
      { generate: vi.fn().mockResolvedValue({ note: 'Nice.', focus_area: 'heat' }) },
      { award },
      { error: vi.fn() }
    );
    const app = express();
    app.use(express.json());
    app.use(
      '/api/check-ins',
      createCheckInRouter(
        { checkInService: service, jwtVerifier: createMockJwtVerifier({ valid: true, userId }) },
        { rateLimit: { windowMs: 60000, maxRequests: 100 } }
      )
    );
    return { app, repository };
  }

  it('returns 201 with xp.status awarded', async () => {
    const award = vi.fn<[string], ReturnType<XpAwarder['award']>>().mockResolvedValue({
      xp_awarded: 102,
      is_first_completion: true,
      weekly_repeat_remaining: 100,
      capped: false,
    });
    const { app } = buildApp(award);

    const response = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer valid-token')
      .send({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' });

    expect(response.status).toBe(201);
    expect(award).toHaveBeenCalledWith(response.body.check_in_id);
    expect(response.body.xp).toEqual({
      status: 'awarded',
      xp_awarded: 102,
      is_first_completion: true,
      capped: false,
    });
  });

  it('still returns 201 and keeps the check-in when the award fails', async () => {
    const award = vi
      .fn<[string], ReturnType<XpAwarder['award']>>()
      .mockRejectedValue(new Error('award_slot_xp failed: 503 unavailable'));
    const { app, repository } = buildApp(award);

    const response = await request(app)
      .post('/api/check-ins')
      .set('Authorization', 'Bearer valid-token')
      .send({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' });

    expect(response.status).toBe(201);
    expect(response.body.xp).toEqual({ status: 'failed' });
    expect(repository.getAllCheckIns().map((c) => c.id)).toEqual([response.body.check_in_id]);
  });
});
