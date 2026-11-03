import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SupabaseCheckInRepository } from './supabase-check-in-repository.js';

const mockFetch = vi.fn();

describe('SupabaseCheckInRepository', () => {
  let repository: SupabaseCheckInRepository;
  const testUserId = randomUUID();
  const testUser2Id = randomUUID();
  const testRecipeId = randomUUID();
  const testSlotId = 1;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    
    repository = new SupabaseCheckInRepository({
      url: 'https://test-project.supabase.co',
      serviceRoleKey: 'test-service-role-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('validateUserRecipe', () => {
    it('sends correct filters for user_id, id, and slot_id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{ id: testRecipeId }],
      });

      await repository.validateUserRecipe(testUserId, testRecipeId, testSlotId);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      
      expect(url).toContain('https://test-project.supabase.co/rest/v1/user_recipes');
      expect(url).toContain(`id=eq.${testRecipeId}`);
      expect(url).toContain(`user_id=eq.${testUserId}`);
      expect(url).toContain(`slot_id=eq.${testSlotId}`);
      
      expect(options.headers).toMatchObject({
        'apikey': 'test-service-role-key',
        'Authorization': 'Bearer test-service-role-key',
      });
    });

    it('returns true when recipe exists and matches', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{ id: testRecipeId }],
      });

      const result = await repository.validateUserRecipe(testUserId, testRecipeId, testSlotId);

      expect(result).toBe(true);
    });

    it('returns false when no matching recipe found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [],
      });

      const result = await repository.validateUserRecipe(testUserId, testRecipeId, testSlotId);

      expect(result).toBe(false);
    });

    it('throws on database error instead of returning false (N7 fix)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => 'Internal server error',
      });

      await expect(
        repository.validateUserRecipe(testUserId, testRecipeId, testSlotId)
      ).rejects.toThrow('Database error validating recipe: 500');
    });

    it('correctly filters so user A cannot validate user B recipe', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [],
      });

      const result = await repository.validateUserRecipe(
        testUser2Id,
        testRecipeId,
        testSlotId
      );

      expect(result).toBe(false);
      
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`user_id=eq.${testUser2Id}`);
    });
  });

  describe('create', () => {
    it('sends correct insert body with all fields', async () => {
      const checkInId = randomUUID();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{
          id: checkInId,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: 'Sauce was great',
          was_hard: 'Timing tricky',
          is_repeat: false,
          created_at: '2026-11-03T12:00:00Z',
        }],
      });

      await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'Sauce was great',
        was_hard: 'Timing tricky',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      
      expect(url).toBe('https://test-project.supabase.co/rest/v1/check_ins');
      expect(options.method).toBe('POST');
      
      const body = JSON.parse(options.body as string);
      expect(body).toEqual({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'Sauce was great',
        was_hard: 'Timing tricky',
      });
    });

    it('sends correct insert body with null optional fields', async () => {
      const checkInId = randomUUID();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{
          id: checkInId,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'easy',
          went_well: null,
          was_hard: null,
          is_repeat: false,
          created_at: '2026-11-03T12:00:00Z',
        }],
      });

      await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'easy',
        went_well: null,
        was_hard: null,
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      
      expect(body.went_well).toBeNull();
      expect(body.was_hard).toBeNull();
    });

    it('returns created check-in record', async () => {
      const checkInId = randomUUID();
      const createdAt = '2026-11-03T12:00:00Z';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{
          id: checkInId,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'hard',
          went_well: 'It worked',
          was_hard: null,
          is_repeat: false,
          created_at: createdAt,
        }],
      });

      const result = await repository.create({
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: 'It worked',
        was_hard: null,
      });

      expect(result).toMatchObject({
        id: checkInId,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: 'It worked',
        was_hard: null,
        is_repeat: false,
      });
      expect(result.created_at).toBeInstanceOf(Date);
    });

    it('throws on insert error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => 'Constraint violation',
      });

      await expect(
        repository.create({
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
        })
      ).rejects.toThrow('Failed to create check-in: 400');
    });
  });

  describe('getById', () => {
    it('returns check-in for owner', async () => {
      const checkInId = randomUUID();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{
          id: checkInId,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: 'Test',
          was_hard: null,
          is_repeat: false,
          created_at: '2026-11-03T12:00:00Z',
        }],
      });

      const result = await repository.getById(checkInId, testUserId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(checkInId);
      
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`id=eq.${checkInId}`);
      expect(url).toContain(`user_id=eq.${testUserId}`);
    });

    it('returns null when not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [],
      });

      const result = await repository.getById(randomUUID(), testUserId);

      expect(result).toBeNull();
    });

    it('throws on database error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => 'Database error',
      });

      await expect(
        repository.getById(randomUUID(), testUserId)
      ).rejects.toThrow('Database error fetching check-in: 500');
    });
  });

  describe('getRecentByUser', () => {
    it('sends correct filters and ordering', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [],
      });

      await repository.getRecentByUser(testUserId, 5);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`user_id=eq.${testUserId}`);
      expect(url).toContain('order=created_at.desc');
      expect(url).toContain('limit=5');
    });

    it('returns check-ins for user', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [
          {
            id: randomUUID(),
            user_id: testUserId,
            user_recipe_id: testRecipeId,
            slot_id: 1,
            difficulty_rating: 'ok',
            went_well: 'First',
            was_hard: null,
            is_repeat: false,
            created_at: '2026-11-03T12:00:00Z',
          },
          {
            id: randomUUID(),
            user_id: testUserId,
            user_recipe_id: testRecipeId,
            slot_id: 1,
            difficulty_rating: 'hard',
            went_well: 'Second',
            was_hard: null,
            is_repeat: true,
            created_at: '2026-11-03T11:00:00Z',
          },
        ],
      });

      const result = await repository.getRecentByUser(testUserId, 5);

      expect(result).toHaveLength(2);
      expect(result[0].went_well).toBe('First');
      expect(result[1].went_well).toBe('Second');
    });

    it('throws on database error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => 'Database error',
      });

      await expect(
        repository.getRecentByUser(testUserId)
      ).rejects.toThrow('Database error fetching check-ins: 500');
    });
  });

  describe('service role authorization', () => {
    it('includes service role key in all requests', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => [],
      });

      await repository.validateUserRecipe(testUserId, testRecipeId, testSlotId);
      await repository.getById(randomUUID(), testUserId);
      await repository.getRecentByUser(testUserId);

      for (const call of mockFetch.mock.calls) {
        const [, options] = call as [string, RequestInit];
        const headers = options.headers as Record<string, string>;
        expect(headers['apikey']).toBe('test-service-role-key');
        expect(headers['Authorization']).toBe('Bearer test-service-role-key');
      }
    });
  });
});
