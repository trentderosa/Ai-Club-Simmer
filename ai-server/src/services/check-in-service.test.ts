import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CheckInService, REPLAY_COACH_NOTE, type CheckInLogger } from './check-in-service.js';
import { InMemoryCheckInRepository } from '../repositories/in-memory-check-in-repository.js';
import { InMemoryGeneratedCheckInRepository } from '../repositories/generated-check-in-repository.js';
import type { CoachNoteGenerator } from './coach-note.js';
import { XpAwardError, type XpAwardResult, type XpAwarder } from './xp-awarder.js';

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

describe('CheckInService idempotent retry', () => {
  const userId = randomUUID();
  const recipeId = randomUUID();
  const key = randomUUID();
  let repository: InMemoryCheckInRepository;
  let coachNoteGenerator: CoachNoteGenerator;
  let logger: CheckInLogger;

  const input = {
    user_recipe_id: recipeId,
    slot_id: 1,
    rating: 'ok' as const,
    idempotency_key: key,
  };

  /**
   * Awards 102 XP the first time a check_in_id is seen, and returns that same
   * result on later calls (stands in for UNIQUE(check_in_id) on xp_events).
   */
  function createIdempotentAwarder(): {
    awarder: XpAwarder;
    awards: Map<string, XpAwardResult>;
  } {
    const awards = new Map<string, XpAwardResult>();
    const awarder: XpAwarder = {
      award: vi.fn((checkInId: string) => {
        const existing = awards.get(checkInId);
        if (existing) return Promise.resolve(existing);
        const result: XpAwardResult = {
          xp_awarded: 102,
          is_first_completion: awards.size === 0,
          weekly_repeat_remaining: 100,
          capped: false,
        };
        awards.set(checkInId, result);
        return Promise.resolve(result);
      }),
    };
    return { awarder, awards };
  }

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    coachNoteGenerator = {
      generate: vi.fn().mockResolvedValue({ note: 'Nice work.', focus_area: 'timing' }),
    };
    logger = { error: vi.fn() };
  });

  it('awards XP once and keeps a single row when the same key is retried after a timeout', async () => {
    const { awarder, awards } = createIdempotentAwarder();
    let releaseFirstNote: () => void = () => undefined;
    let awardedFirst!: () => void;
    const firstAwarded = new Promise<void>((resolve) => {
      awardedFirst = resolve;
    });
    let noteCalls = 0;
    const coach: CoachNoteGenerator = {
      generate: vi.fn((): Promise<{ note: string; focus_area: string }> => {
        noteCalls += 1;
        if (noteCalls === 1) {
          return new Promise((resolve) => {
            releaseFirstNote = (): void => resolve({ note: 'Nice work.', focus_area: 'timing' });
          });
        }
        return Promise.resolve({ note: 'Nice work.', focus_area: 'timing' });
      }),
    };
    const originalAward = awarder.award;
    awarder.award = vi.fn(async (checkInId: string) => {
      const result = await originalAward(checkInId);
      awardedFirst();
      return result;
    });
    const service = new CheckInService(repository, coach, awarder, logger);

    // First POST saves the row and awards XP, then hangs on the coach's note
    // (the app times out here). The retry reuses the key and completes.
    const first = service.processCheckIn(userId, input);
    await firstAwarded;
    const retry = await service.processCheckIn(userId, input);
    releaseFirstNote();
    const original = await first;

    expect(repository.getAllCheckIns()).toHaveLength(1);
    expect(retry.check_in_id).toBe(original.check_in_id);
    expect(retry.check_in_id).toBe(key);
    expect(retry.xp).toEqual({
      status: 'awarded',
      xp_awarded: 102,
      is_first_completion: true,
      capped: false,
    });
    expect(original.xp).toEqual(retry.xp);
    expect(awarder.award).toHaveBeenCalledTimes(2);
    expect(awarder.award).toHaveBeenCalledWith(key);
    expect(awards.size).toBe(1);
    const totalXp = [...awards.values()].reduce((sum, a) => sum + a.xp_awarded, 0);
    expect(totalXp).toBe(102);
    expect(coach.generate).toHaveBeenCalledTimes(1);
    expect(retry.coach_note).toBe(REPLAY_COACH_NOTE.note);
    expect(retry.focus_area).toBeUndefined();
    expect(original.coach_note).toBe('Nice work.');
  });

  it('creates two check-ins and two awards when the keys differ (a real repeat)', async () => {
    const { awarder, awards } = createIdempotentAwarder();
    const service = new CheckInService(repository, coachNoteGenerator, awarder, logger);

    const first = await service.processCheckIn(userId, { ...input, idempotency_key: randomUUID() });
    const second = await service.processCheckIn(userId, { ...input, idempotency_key: randomUUID() });

    expect(first.check_in_id).not.toBe(second.check_in_id);
    expect(repository.getAllCheckIns()).toHaveLength(2);
    expect(awards.size).toBe(2);
    expect(second.xp).toEqual({
      status: 'awarded',
      xp_awarded: 102,
      is_first_completion: false,
      capped: false,
    });
    expect(awarder.award).toHaveBeenCalledTimes(2);
  });
});

describe('CheckInService coach note context', () => {
  const userId = randomUUID();
  const recipeId = randomUUID();
  let repository: InMemoryCheckInRepository;
  let coach: CoachNoteGenerator;
  let logger: CheckInLogger;
  const slot = { id: 1, dishName: 'Sheet Pan Vegetables', techniqueFocus: 'roasting' };
  const input = (): { user_recipe_id: string; slot_id: number; rating: 'ok'; idempotency_key: string } => ({ user_recipe_id: recipeId, slot_id: 1, rating: 'ok' as const, idempotency_key: randomUUID() });

  beforeEach(() => {
    repository = new InMemoryCheckInRepository();
    repository.seedUserRecipe({ id: recipeId, user_id: userId, slot_id: 1 });
    coach = { generate: vi.fn().mockResolvedValue({ note: 'Nice work.' }) };
    logger = { error: vi.fn() };
  });

  it('passes the slot dish name and the equipment to the coach note', async () => {
    const pathRepository = {
      getPathSlot: vi.fn().mockResolvedValue(slot),
      badgesEarnedBy: vi.fn().mockResolvedValue([]),
      getEquipment: vi.fn().mockResolvedValue(['stove', 'oven', 'knife']),
    };
    const service = new CheckInService(repository, coach, null, logger, { pathRepository });
    await service.processCheckIn(userId, input());
    expect(pathRepository.getEquipment).toHaveBeenCalledWith(userId);
    expect(coach.generate).toHaveBeenCalledWith('ok', null, null, {
      dishName: 'Sheet Pan Vegetables',
      equipment: ['stove', 'oven', 'knife'],
    });
  });

  it('still generates the note when the equipment lookup fails', async () => {
    const pathRepository = {
      getPathSlot: vi.fn().mockResolvedValue(slot),
      badgesEarnedBy: vi.fn().mockResolvedValue([]),
      getEquipment: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const service = new CheckInService(repository, coach, null, logger, { pathRepository });
    const result = await service.processCheckIn(userId, input());
    expect(result.coach_note).toBe('Nice work.');
    expect(coach.generate).toHaveBeenCalledWith('ok', null, null, { dishName: 'Sheet Pan Vegetables' });
    expect(logger.error).toHaveBeenCalledWith('coach_note_equipment_lookup_failed', { error: 'db down' });
  });

  it('still generates the note when the slot lookup fails', async () => {
    const pathRepository = {
      getPathSlot: vi.fn().mockRejectedValue(new Error('slot down')),
      badgesEarnedBy: vi.fn().mockResolvedValue([]),
      getEquipment: vi.fn().mockResolvedValue(['stove']),
    };
    const service = new CheckInService(repository, coach, null, logger, { pathRepository });
    await service.processCheckIn(userId, input());
    expect(coach.generate).toHaveBeenCalledWith('ok', null, null, { equipment: ['stove'] });
  });

  it('uses the generated recipe dish name for Cook anything check-ins', async () => {
    const generatedCheckInRepository = new InMemoryGeneratedCheckInRepository();
    const generatedId = randomUUID();
    generatedCheckInRepository.seedRecipe(userId, generatedId, 'Pad Thai');
    const pathRepository = {
      getPathSlot: vi.fn(),
      badgesEarnedBy: vi.fn().mockResolvedValue([]),
      getEquipment: vi.fn().mockResolvedValue(['wok']),
    };
    const service = new CheckInService(repository, coach, null, logger, {
      pathRepository,
      generatedCheckInRepository,
    });
    await service.processCheckIn(userId, {
      generated_recipe_id: generatedId,
      rating: 'easy',
      idempotency_key: randomUUID(),
    });
    expect(pathRepository.getPathSlot).not.toHaveBeenCalled();
    expect(coach.generate).toHaveBeenCalledWith('easy', null, null, { dishName: 'Pad Thai', equipment: ['wok'] });
  });

  it('skips the lookups on an idempotent replay', async () => {
    const pathRepository = {
      getPathSlot: vi.fn().mockResolvedValue(slot),
      badgesEarnedBy: vi.fn().mockResolvedValue([]),
      getEquipment: vi.fn().mockResolvedValue(['stove']),
    };
    const service = new CheckInService(repository, coach, null, logger, { pathRepository });
    const body = input();
    await service.processCheckIn(userId, body);
    pathRepository.getEquipment.mockClear();
    await service.processCheckIn(userId, body);
    expect(pathRepository.getEquipment).not.toHaveBeenCalled();
  });
});
