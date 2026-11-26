import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInIdempotencyConflict, CheckInMasterySessionError } from '../types/check-in.js';
import { SupabaseRestError } from '../services/supabase-rest.js';
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

    it('includes a client-supplied id in the insert body', async () => {
      const id = randomUUID();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => [{
          id,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
          is_repeat: false,
          created_at: '2026-11-03T12:00:00Z',
        }],
      });

      const result = await repository.create({
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: null,
        was_hard: null,
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(options.body as string).id).toBe(id);
      expect(result.id).toBe(id);
      expect(result.created).toBe(true);
    });

    it('returns the existing row when insert hits 409 for the same check-in', async () => {
      const id = randomUUID();
      const existing = {
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'ok',
        went_well: 'first write',
        was_hard: null,
        is_repeat: false,
        created_at: '2026-11-03T12:00:00Z',
      };
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 409, text: () => 'duplicate key' })
        .mockResolvedValueOnce({ ok: true, json: () => [existing] });

      const result = await repository.create({
        id,
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: testSlotId,
        difficulty_rating: 'hard',
        went_well: 'retry',
        was_hard: null,
      });

      expect(result.id).toBe(id);
      expect(result.created).toBe(false);
      expect(result.went_well).toBe('first write');
      expect(result.difficulty_rating).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toContain(`/check_ins?`);
      expect(url).toContain(`id=eq.${id}`);
    });

    it('throws CheckInIdempotencyConflict when 409 row belongs to a different recipe', async () => {
      const id = randomUUID();
      const otherRecipe = randomUUID();
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 409, text: () => 'duplicate key' })
        .mockResolvedValueOnce({
          ok: true,
          json: () => [{
            id,
            user_id: testUserId,
            user_recipe_id: otherRecipe,
            slot_id: 2,
            difficulty_rating: 'ok',
            went_well: null,
            was_hard: null,
            is_repeat: false,
            created_at: '2026-11-03T12:00:00Z',
          }],
        });

      await expect(
        repository.create({
          id,
          user_id: testUserId,
          user_recipe_id: testRecipeId,
          slot_id: testSlotId,
          difficulty_rating: 'ok',
          went_well: null,
          was_hard: null,
        })
      ).rejects.toBeInstanceOf(CheckInIdempotencyConflict);
    });

    describe('F8 mastery sessions', () => {
      const sessionId = randomUUID();
      const base = {
        user_id: testUserId,
        user_recipe_id: testRecipeId,
        slot_id: 10,
        difficulty_rating: 'ok' as const,
        went_well: null,
        was_hard: null,
        mastery_session_id: sessionId,
      };

      it('sends mastery_session_id and never client counts', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => [{ id: randomUUID(), ...base, is_repeat: false, created_at: '2026-11-16T12:00:00Z' }],
        });
        await repository.create(base);
        const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
        expect(body.mastery_session_id).toBe(sessionId);
        expect(body).not.toHaveProperty('hidden_steps');
        expect(body).not.toHaveProperty('revealed_steps');
      });

      it('a 409 on the session (new id) is MASTERY_SESSION_USED', async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 409,
            text: () => '{"code":"23505","message":"duplicate key value violates unique constraint \\"check_ins_mastery_session_id_key\\""}',
          })
          .mockResolvedValueOnce({ ok: true, json: () => [] });
        const err = await repository.create({ ...base, id: randomUUID() }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CheckInMasterySessionError);
        expect((err as CheckInMasterySessionError).code).toBe('MASTERY_SESSION_USED');
      });

      it('a 409 that is a replay of the same check-in returns the existing row', async () => {
        const id = randomUUID();
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 409, text: () => 'check_ins_mastery_session_id_key' })
          .mockResolvedValueOnce({
            ok: true,
            json: () => [{ id, ...base, is_repeat: false, created_at: '2026-11-16T12:00:00Z' }],
          });
        const result = await repository.create({ ...base, id });
        expect(result.created).toBe(false);
        expect(result.id).toBe(id);
      });

      it('a session for another user/recipe is INVALID_MASTERY_SESSION', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => '{"code":"P0001","message":"mastery session does not match this check-in"}',
        });
        const err = await repository.create(base).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CheckInMasterySessionError);
        expect((err as CheckInMasterySessionError).code).toBe('INVALID_MASTERY_SESSION');
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

  describe('request timeouts', () => {
    const hangUntilAborted = (): void => {
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
    };

    const createParams = {
      user_id: 'user-1@simmer.invalid',
      user_recipe_id: 'recipe-1',
      slot_id: 1,
      difficulty_rating: 'easy' as const,
      went_well: null,
      was_hard: null,
    };

    const methods: Array<[string, string, (r: SupabaseCheckInRepository) => Promise<unknown>]> = [
      ['validateUserRecipe', 'check-in read', (r): Promise<unknown> => r.validateUserRecipe('u', 'r', 1)],
      ['create', 'check-in create', (r): Promise<unknown> => r.create(createParams)],
      ['getById', 'check-in read', (r): Promise<unknown> => r.getById('c', 'u')],
      ['getRecentByUser', 'check-in read', (r): Promise<unknown> => r.getRecentByUser('u')],
    ];

    it.each(methods)('%s passes an AbortSignal to fetch', async (_name, _label, call) => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => [{ id: 'x' }] });
      await call(repository);
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it.each(methods)('%s rejects with a timeout SupabaseRestError when fetch hangs', async (_name, label, call) => {
      hangUntilAborted();
      const slow = new SupabaseCheckInRepository({
        url: 'https://test-project.supabase.co',
        serviceRoleKey: 'test-service-role-key',
        timeoutMs: 20,
      });
      const error = await call(slow).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
      expect((error as SupabaseRestError).message).toBe(`Supabase ${label} timed out after 20ms`);
    });

    it('times out getByIdAny during an idempotent replay and when the body never arrives', async () => {
      const slow = new SupabaseCheckInRepository({
        url: 'https://test-project.supabase.co',
        serviceRoleKey: 'test-service-role-key',
        timeoutMs: 20,
      });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 409, text: () => Promise.resolve('{}') })
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                new Promise((_resolve, reject) => {
                  init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
            })
        );
      const error = await slow.create({ ...createParams, id: randomUUID() }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupabaseRestError);
      expect((error as SupabaseRestError).kind).toBe('timeout');
    });
  });
});
