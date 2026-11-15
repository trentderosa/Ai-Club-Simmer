import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInService, type CheckInLogger } from './check-in-service.js';
import { InMemoryCheckInRepository } from '../repositories/in-memory-check-in-repository.js';
import type { CoachNoteGenerator } from './coach-note.js';
import { XpAwardError, type XpAwarder } from './xp-awarder.js';

describe('CheckInService XP award', () => {
  const userId = randomUUID();
  const recipeId = randomUUID();
  let repository: InMemoryCheckInRepository;
  let coachNoteGenerator: CoachNoteGenerator;
  let logger: CheckInLogger;

  const input = { user_recipe_id: recipeId, slot_id: 1, rating: 'ok' as const };

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    coachNoteGenerator = {
      generate: vi.fn().mockResolvedValue({ note: 'Nice work.', focus_area: 'timing' }),
    };
    logger = { error: vi.fn() };
  });

  it('calls award once with the saved check_in_id and returns awarded', async () => {
    const xpAwarder: XpAwarder = {
      award: vi.fn().mockResolvedValue({
        xp_awarded: 102,
        is_first_completion: true,
        weekly_repeat_remaining: 100,
        capped: false,
      }),
    };
    const service = new CheckInService(repository, coachNoteGenerator, xpAwarder, logger);

    const response = await service.processCheckIn(userId, input);

    expect(xpAwarder.award).toHaveBeenCalledTimes(1);
    expect(xpAwarder.award).toHaveBeenCalledWith(response.check_in_id);
    expect(repository.getAllCheckIns().map((c) => c.id)).toEqual([response.check_in_id]);
    expect(response.xp).toEqual({
      status: 'awarded',
      xp_awarded: 102,
      is_first_completion: true,
      capped: false,
    });
    expect(response.coach_note).toBe('Nice work.');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps the check-in, logs with check_in_id, and returns failed when the award throws', async () => {
    const xpAwarder: XpAwarder = {
      award: vi.fn().mockRejectedValue(new Error('award_slot_xp failed: 500 boom')),
    };
    const service = new CheckInService(repository, coachNoteGenerator, xpAwarder, logger);

    const response = await service.processCheckIn(userId, input);

    expect(xpAwarder.award).toHaveBeenCalledTimes(1);
    const saved = repository.getAllCheckIns();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(response.check_in_id);
    expect(response.xp).toEqual({ status: 'failed' });
    expect(response.coach_note).toBe('Nice work.');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('xp_award_failed', {
      check_in_id: response.check_in_id,
      slot_id: 1,
      reason: 'unknown',
      error: 'award_slot_xp failed: 500 boom',
    });
  });

  it('treats an award timeout as failed: check-in kept, logged with reason "timeout"', async () => {
    const xpAwarder: XpAwarder = {
      award: vi
        .fn()
        .mockRejectedValue(new XpAwardError('timeout', 'award_slot_xp timed out after 5000ms')),
    };
    const service = new CheckInService(repository, coachNoteGenerator, xpAwarder, logger);

    const response = await service.processCheckIn(userId, input);

    expect(repository.getAllCheckIns().map((c) => c.id)).toEqual([response.check_in_id]);
    expect(response.xp).toEqual({ status: 'failed' });
    expect(response.coach_note).toBe('Nice work.');
    expect(logger.error).toHaveBeenCalledWith('xp_award_failed', {
      check_in_id: response.check_in_id,
      slot_id: 1,
      reason: 'timeout',
      error: 'award_slot_xp timed out after 5000ms',
    });
  });

  it('returns skipped and does not log when no awarder is configured (dev)', async () => {
    const service = new CheckInService(repository, coachNoteGenerator, null, logger);

    const response = await service.processCheckIn(userId, input);

    expect(response.xp).toEqual({ status: 'skipped' });
    expect(repository.getAllCheckIns()).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
