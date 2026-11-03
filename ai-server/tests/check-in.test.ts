import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createApp } from '../src/app.js';
import { CheckInService } from '../src/services/check-in-service.js';
import { InMemoryCheckInRepository } from '../src/repositories/in-memory-check-in-repository.js';
import { createTestJwt, createExpiredTestJwt } from '../src/middleware/auth.js';
import type { Express } from 'express';

process.env.SUPABASE_JWT_SECRET = 'test-secret-key-at-least-32-characters-long';

vi.mock('../src/services/ollama-service.js', () => ({
  generateCoachNote: vi.fn().mockResolvedValue({
    note: 'Great job! Keep practicing your knife skills.',
    focus_area: 'knife skills',
  }),
  FALLBACK_NOTE: {
    note: "Great job completing this recipe! Keep practicing and you'll continue to improve. Focus on the basics and don't be afraid to experiment.",
    focus_area: 'general practice',
  },
}));

describe('Check-in API (F6)', () => {
  let app: Express;
  let repository: InMemoryCheckInRepository;
  let testUserId: string;
  let testUserToken: string;
  let testUser2Id: string;
  let testUser2Token: string;
  let testRecipeId: string;
  const testSlotId = 1;

  beforeAll(async () => {
    testUserId = randomUUID();
    testUser2Id = randomUUID();
    testUserToken = await createTestJwt(testUserId, 'test@example.com');
    testUser2Token = await createTestJwt(testUser2Id, 'test2@example.com');
  });

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    const service = new CheckInService(repository);
    app = createApp({ checkInService: service });

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
        .post('/check-ins')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Missing Authorization header');
    });

    it('returns 401 when Authorization header format is invalid', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', 'InvalidFormat')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid Authorization header format');
    });

    it('returns 401 when token is invalid', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', 'Bearer invalid-token')
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid token');
    });

    it('returns 401 when token is expired', async () => {
      const expiredToken = await createExpiredTestJwt(testUserId);

      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Token expired');
    });

    it('accepts valid JWT and creates check-in', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
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
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'user_recipe_id' })
      );
    });

    it('returns 400 when user_recipe_id is not a UUID', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: 'not-a-uuid',
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when slot_id is missing', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'slot_id' })
      );
    });

    it('returns 400 when slot_id is out of range (< 1)', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: 0,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when slot_id is out of range (> 10)', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: 11,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when rating is missing', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'rating' })
      );
    });

    it('returns 400 when rating is invalid', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
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
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
          went_well: 'a'.repeat(501),
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when was_hard exceeds 500 characters', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'ok',
          was_hard: 'a'.repeat(501),
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when user_recipe_id does not exist', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: randomUUID(),
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECIPE');
    });

    it('returns 400 when slot_id does not match user_recipe', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: 2,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECIPE');
    });
  });

  describe('Successful check-in', () => {
    it('creates check-in with minimal fields', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
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
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
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

    it('accepts all valid rating values', async () => {
      for (const rating of ['easy', 'ok', 'hard'] as const) {
        const response = await request(app)
          .post('/check-ins')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            user_recipe_id: testRecipeId,
            slot_id: testSlotId,
            rating,
          });

        expect(response.status).toBe(201);
      }
    });

    it('persists check-in to repository', async () => {
      const response = await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
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
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: user2RecipeId,
          slot_id: testSlotId,
          rating: 'ok',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECIPE');
    });

    it('users have separate check-in records', async () => {
      const user2RecipeId = randomUUID();
      repository.seedUserRecipe({
        id: user2RecipeId,
        user_id: testUser2Id,
        slot_id: testSlotId,
      });

      await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          rating: 'easy',
        });

      await request(app)
        .post('/check-ins')
        .set('Authorization', `Bearer ${testUser2Token}`)
        .send({
          user_recipe_id: user2RecipeId,
          slot_id: testSlotId,
          rating: 'hard',
        });

      const checkIns = repository.getAllCheckIns();
      expect(checkIns).toHaveLength(2);
      
      const user1CheckIns = checkIns.filter(c => c.user_id === testUserId);
      const user2CheckIns = checkIns.filter(c => c.user_id === testUser2Id);
      
      expect(user1CheckIns).toHaveLength(1);
      expect(user1CheckIns[0].difficulty_rating).toBe('easy');
      
      expect(user2CheckIns).toHaveLength(1);
      expect(user2CheckIns[0].difficulty_rating).toBe('hard');
    });
  });

  describe('Health endpoint', () => {
    it('returns ok status', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });
});
