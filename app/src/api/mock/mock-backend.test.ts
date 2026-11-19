import { BADGES, MASTERY_USER, MASTERY_USER_XP, RECIPES, SLOTS } from './fixtures';
import { catalogBadge, createMockBackend, mockUserRecipeId } from './mock-backend';
import { awardXp, derivePlan, deriveSummary } from './mock-plan';

describe('mock plan rules', () => {
  it('matches the real 10 slots and XP values', () => {
    expect(SLOTS.map((s) => s.xp_value)).toEqual([102, 62, 75, 143, 65, 105, 137, 80, 148, 181]);
    expect(SLOTS.filter((s) => s.is_final).map((s) => s.slot_order)).toEqual([10]);
  });

  it('derives done / current / locked', () => {
    const plan = derivePlan(SLOTS, { 1: 1, 2: 2 }, new Set([1, 2]));
    expect(plan.map((p) => p.status)).toEqual(['done', 'done', 'current', ...Array(7).fill('locked')]);
  });

  it('suggests sessions per week like the SQL rule', () => {
    const plan = derivePlan(SLOTS, {}, new Set());
    const s = deriveSummary(plan, SLOTS, 0, { days_per_week: 3, minutes_per_session: 30 });
    expect(s.suggested_sessions_per_week).toBe(2); // PRD open question 11 example: 3 x 30 -> 2
    expect(s.estimated_weeks_remaining).toBe(5);
    expect(deriveSummary(plan, SLOTS, 0, null).suggested_sessions_per_week).toBeNull();
  });

  it('awards half XP on repeats, capped at 100 a week', () => {
    expect(awardXp(143, true, 0)).toEqual({ xp_awarded: 143, capped: false });
    expect(awardXp(143, false, 0)).toEqual({ xp_awarded: 72, capped: false });
    expect(awardXp(143, false, 72)).toEqual({ xp_awarded: 28, capped: true });
    expect(awardXp(143, false, 100)).toEqual({ xp_awarded: 0, capped: true });
  });
});

describe('mock badge catalog', () => {
  it('includes every badge code the mock awards, and throws on a missing code', () => {
    const codes = BADGES.map((b) => b.code);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(codes).toContain(`complete_slot_${n}`);
    }
    expect(codes).toContain('mastery');
    expect(codes).toContain('path_weeknight_basics');
    expect(catalogBadge('mastery').name).toBe('Roast Chicken Mastery');
    expect(() => catalogBadge('complete_slot_10')).toThrow(/Unknown badge code in mock catalog: complete_slot_10/);
    expect(() => catalogBadge('not_a_real_badge')).toThrow(/Unknown badge code in mock catalog: not_a_real_badge/);
  });
});

describe('mock backend', () => {
  it('runs the core loop end to end', async () => {
    const b = createMockBackend({ latency: 0 });
    await b.signIn('demo@simmer.test', 'whatever');
    const session = await b.getSession();
    expect(session?.firstName).toBe('Jordan');

    expect((await b.getPlanSummary()).total_xp).toBe(239);
    const plan = await b.getPlan();
    expect(plan.find((p) => p.status === 'current')?.slot_order).toBe(4);

    await expect(b.generateRecipe(5, 't')).rejects.toMatchObject({ kind: 'slot_locked' });
    const recipe = await b.generateRecipe(4, 't');
    expect(recipe.recipe.steps.length).toBeGreaterThan(0);
    expect(Object.keys(recipe.videos)).toHaveLength(2);

    const id = await b.getUserRecipeId(4);
    expect(id).toBe(mockUserRecipeId(4));
    const res = await b.submitCheckIn({ user_recipe_id: id, slot_id: 4, rating: 'hard' }, 't');
    expect(res.xp).toEqual({ status: 'awarded', xp_awarded: 143, is_first_completion: true, capped: false });
    expect(res.suggest_repeat).toBe(true);
    expect(res.badges).toMatchObject({ status: 'ok', earned: [{ code: 'complete_slot_4' }] });

    expect((await b.getPlanSummary()).total_xp).toBe(382);
    expect((await b.getPlan()).find((p) => p.status === 'current')?.slot_order).toBe(5);

    const repeat = await b.submitCheckIn({ user_recipe_id: id, slot_id: 4, rating: 'ok' }, 't');
    expect(repeat.xp).toMatchObject({ xp_awarded: 72, is_first_completion: false });
    expect(repeat.badges).toEqual({ status: 'ok', earned: [] });
  });

  it('sends new users through onboarding', async () => {
    const b = createMockBackend({ latency: 0 });
    await b.signUp('new@simmer.test', 'secret1', 'Sam');
    const s = await b.getSession();
    expect(await b.getProfile(s!.userId)).toBeNull();
    await expect(b.generateRecipe(1, 't')).rejects.toMatchObject({ kind: 'onboarding_required' });
    await b.saveOnboarding(s!.userId, { goals: '', experience_level: 'never_cooked', equipment: ['stove'], budget: 'low', days_per_week: 2, minutes_per_session: 30 });
    expect((await b.getProfile(s!.userId))?.onboarding_completed).toBe(true);
    expect((await b.getPlan())[0].status).toBe('current');
  });

  it('can simulate a failed XP award', async () => {
    const b = createMockBackend({ latency: 0, xpStatus: 'failed', startSignedIn: true });
    await b.generateRecipe(4, 't');
    const res = await b.submitCheckIn({ user_recipe_id: mockUserRecipeId(4), slot_id: 4, rating: 'ok' }, 't');
    expect(res.xp).toEqual({ status: 'failed' });
    expect((await b.getPlanSummary()).total_xp).toBe(239);
  });

  it('replays a timed-out check-in with the same key and awards XP only once', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    await b.generateRecipe(4, 't');
    const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const body = { user_recipe_id: mockUserRecipeId(4), slot_id: 4, rating: 'ok' as const, idempotency_key: key };
    const first = await b.submitCheckIn(body, 't');
    const retry = await b.submitCheckIn({ ...body, rating: 'hard' }, 't');
    expect(first.check_in_id).toBe(key);
    expect(retry).toEqual(first);
    expect(retry.xp).toEqual({ status: 'awarded', xp_awarded: 143, is_first_completion: true, capped: false });
    expect((await b.getPlanSummary()).total_xp).toBe(382);
    expect((await b.getPlan()).find((p) => p.slot_id === 4)?.times_completed).toBe(1);
  });

  it('returns a canned cook-anything recipe, reuses it, and awards repeat XP once', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    const first = await b.cookAnything('  Pad Thai!! ', 't');
    expect(first.cached).toBe(false);
    expect(first.recipe.title).toBe('Pad Thai!!');
    expect(first.counts).toEqual({ steps: 5, ingredients: 6, minutes: 20 });
    expect(first.xp_value).toBe(84);
    expect(first.photo?.credit.license).toBe('Public domain');
    expect(first.photo?.url).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
    const again = await b.cookAnything('pad thai', 't');
    expect(again.cached).toBe(true);
    expect(again.generated_recipe_id).toBe(first.generated_recipe_id);
    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const check = await b.submitCheckIn(
      { generated_recipe_id: first.generated_recipe_id, rating: 'ok', idempotency_key: key },
      't',
    );
    expect(check.xp).toEqual({ status: 'awarded', xp_awarded: 84, is_first_completion: true, capped: false });
    const retry = await b.submitCheckIn(
      { generated_recipe_id: first.generated_recipe_id, rating: 'hard', idempotency_key: key },
      't',
    );
    expect(retry).toEqual(check);
    const secondCook = await b.submitCheckIn(
      { generated_recipe_id: first.generated_recipe_id, rating: 'ok', idempotency_key: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      't',
    );
    expect(secondCook.xp).toEqual({ status: 'awarded', xp_awarded: 42, is_first_completion: false, capped: false });
  });

  it('rejects an empty cook-anything query', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    await expect(b.cookAnything('   ', 't')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('returns no photo for the canned fallback dish so the hero can use board.jpg', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    const res = await b.cookAnything('invisible stew', 't');
    expect(res.photo).toBeNull();
  });

  it('lists the recipe book and badges for the demo user', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    const book = await b.getRecipeBook();
    expect(book.map((e) => e.slot_order)).toEqual([1, 2, 3]);
    expect(book.map((e) => e.label)).toEqual(['completed', 'completed', 'completed']);
    expect(book.find((e) => e.slot_id === 2)?.times_cooked).toBe(2);
    expect(book.find((e) => e.slot_id === 3)?.recipe_title).toMatch(/Pasta/i);
    expect(book.every((e) => e.user_recipe_id)).toBe(true);

    const badges = await b.getBadges();
    expect(badges).toHaveLength(BADGES.length);
    expect(badges.filter((x) => x.earned).map((x) => x.code)).toEqual([
      'complete_slot_1',
      'complete_slot_2',
      'complete_slot_3',
    ]);
    expect(badges.find((x) => x.code === 'mastery')?.earned).toBe(false);
    expect(badges.find((x) => x.code === 'path_weeknight_basics')?.earned).toBe(false);
  });

  it('adds a mastered entry and the path badge after slot 10', async () => {
    const b = createMockBackend({ latency: 0 });
    await b.signUp('grad@simmer.test', 'secret1', 'Sam');
    const s = await b.getSession();
    await b.saveOnboarding(s!.userId, {
      goals: '',
      experience_level: 'a_little',
      equipment: ['stove'],
      budget: 'low',
      days_per_week: 3,
      minutes_per_session: 30,
    });
    for (const slotId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await b.generateRecipe(slotId, 't');
      await b.submitCheckIn({ user_recipe_id: mockUserRecipeId(slotId), slot_id: slotId, rating: 'ok' }, 't');
    }
    const book = await b.getRecipeBook();
    expect(book).toHaveLength(10);
    expect(book.find((e) => e.slot_id === 10)).toMatchObject({ label: 'mastered' });
    const badges = await b.getBadges();
    expect(badges.find((x) => x.code === 'path_weeknight_basics')?.earned).toBe(true);
    // No mastery payload → no mastery badge.
    expect(badges.find((x) => x.code === 'mastery')?.earned).toBe(false);
  });
});

describe('mock recipe book: Cook anything and check-in history', () => {
  const U1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  const U2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
  const U3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';

  it('adds a Cook anything dish to the book only after a check-in, once, with the right count', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    const pathOnly = (await b.getRecipeBook()).length;
    const dish = await b.cookAnything('pad thai', 't');
    expect((await b.getRecipeBook()).length).toBe(pathOnly);

    await b.submitCheckIn({ generated_recipe_id: dish.generated_recipe_id, rating: 'hard', was_hard: ' noodles stuck ', idempotency_key: U1 }, 't');
    await b.submitCheckIn({ generated_recipe_id: dish.generated_recipe_id, rating: 'easy', went_well: 'sauce', idempotency_key: U2 }, 't');
    const book = await b.getRecipeBook();
    expect(book).toHaveLength(pathOnly + 1);
    expect(book.filter((e) => e.kind === 'path').map((e) => e.slot_id)).toEqual([1, 2, 3]);
    const entry = book.find((e) => e.kind === 'cook_anything');
    expect(entry).toMatchObject({
      slot_id: null,
      slot_order: null,
      user_recipe_id: null,
      generated_recipe_id: dish.generated_recipe_id,
      dish_name: 'pad thai',
      label: 'completed',
      times_cooked: 2,
      last_difficulty_rating: 'easy',
    });
    expect(entry?.recipe_title).toBe(dish.recipe.title);

    const history = await b.getCheckInHistory({ kind: 'cook_anything', generatedRecipeId: dish.generated_recipe_id });
    expect(history.map((h) => [h.difficulty_rating, h.went_well, h.was_hard])).toEqual([
      ['easy', 'sauce', null],
      ['hard', null, 'noodles stuck'],
    ]);
  });

  it('records path check-ins with notes, newest first, and keeps them per slot', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    await b.generateRecipe(3, 't');
    await b.submitCheckIn({ user_recipe_id: mockUserRecipeId(3), slot_id: 3, rating: 'hard', was_hard: 'boil over', idempotency_key: U3 }, 't');
    const slot3 = await b.getCheckInHistory({ kind: 'path', slotId: 3 });
    expect(slot3[0]).toMatchObject({ difficulty_rating: 'hard', was_hard: 'boil over', went_well: null });
    // Slot 2 was cooked twice before the demo user's history started (one plain row per canned cook).
    expect(await b.getCheckInHistory({ kind: 'path', slotId: 2 })).toHaveLength(2);
    expect(await b.getCheckInHistory({ kind: 'path', slotId: 9 })).toEqual([]);
    const entry = (await b.getRecipeBook()).find((e) => e.slot_id === 3);
    expect(entry).toMatchObject({ kind: 'path', generated_recipe_id: null, last_difficulty_rating: 'hard' });
  });

  it('does not carry history to a different account', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    const dish = await b.cookAnything('ramen', 't');
    await b.submitCheckIn({ generated_recipe_id: dish.generated_recipe_id, rating: 'ok' }, 't');
    await b.signUp('fresh@simmer.test', 'secret1', 'Sam');
    expect((await b.getRecipeBook())).toEqual([]);
    expect(await b.getCheckInHistory({ kind: 'cook_anything', generatedRecipeId: dish.generated_recipe_id })).toEqual([]);
  });
});

describe('mock mastery account and check-in payload', () => {
  it('keeps the default demo user on startSignedIn and on a normal sign-in', async () => {
    const started = createMockBackend({ latency: 0, startSignedIn: true });
    const plan = await started.getPlan();
    expect((await started.getSession())?.email).toBe('demo@simmer.test');
    expect(plan.find((s) => s.status === 'current')?.slot_order).toBe(4);
    expect((await started.getPlanSummary()).total_xp).toBe(239);

    const signed = createMockBackend({ latency: 0 });
    await signed.signIn('anyone@simmer.test', 'secret');
    expect((await signed.getSession())?.firstName).toBe('Jordan');
    expect((await signed.getPlan()).find((s) => s.status === 'current')?.slot_order).toBe(4);
  });

  it('signs in mastery@simmer.test already at slot 10', async () => {
    const b = createMockBackend({ latency: 0 });
    await b.signIn(MASTERY_USER.email, 'any-password');
    const session = await b.getSession();
    expect(session?.email).toBe('mastery@simmer.test');
    expect(session?.firstName).toBe('Riley');
    const plan = await b.getPlan();
    expect(plan.filter((s) => s.status === 'done')).toHaveLength(9);
    expect(plan.find((s) => s.status === 'current')).toMatchObject({ slot_order: 10, is_final: true });
    expect((await b.getPlanSummary()).total_xp).toBe(MASTERY_USER_XP);
    expect((await b.getBadges()).find((x) => x.code === 'mastery')?.earned).toBe(false);
  });

  async function masteryUser() {
    const b = createMockBackend({ latency: 0 });
    await b.signIn(MASTERY_USER.email, 'x');
    await b.generateRecipe(10, 't');
    return b;
  }

  it('masks the hidden steps of the final recipe (like the live server)', async () => {
    const b = await masteryUser();
    const { recipe } = await b.generateRecipe(10, 't');
    expect(recipe.steps.map((s) => s.isHidden ?? false)).toEqual([false, false, true, true, false, true]);
    expect(recipe.steps[2].instruction).not.toBe(RECIPES[10].steps[2].instruction);
    expect(recipe.steps[0]).toEqual(RECIPES[10].steps[0]);
  });

  it('awards the mastery badge only when the session has zero reveals', async () => {
    const zero = await masteryUser();
    const session = await zero.startMastery(10, 't');
    expect(session.hidden_step_indices).toEqual([2, 3, 5]);
    const perfect = await zero.submitCheckIn(
      { user_recipe_id: mockUserRecipeId(10), slot_id: 10, rating: 'ok', mastery_session_id: session.session_id },
      't',
    );
    expect(perfect.xp).toEqual({ status: 'awarded', xp_awarded: 181, is_first_completion: true, capped: false });
    expect(perfect.badges).toMatchObject({
      status: 'ok',
      earned: [
        expect.objectContaining({ code: 'mastery', kind: 'mastery', name: 'Roast Chicken Mastery' }),
        expect.objectContaining({ code: 'path_weeknight_basics', description: 'Finished all 10 recipes on the Weeknight basics path.' }),
      ],
    });
    expect((await zero.getBadges()).find((x) => x.code === 'mastery')?.earned).toBe(true);
  });

  it('a reveal returns the real step, and the session remembers it', async () => {
    const b = await masteryUser();
    const session = await b.startMastery(10, 't');
    const r = await b.revealMasteryStep(session.session_id, 3, 't');
    expect(r.step).toEqual(RECIPES[10].steps[3]);
    expect(r.revealed_step_indices).toEqual([3]);
    const resumed = await b.startMastery(10, 't');
    expect(resumed.session_id).toBe(session.session_id);
    expect(resumed.revealed_steps).toEqual({ '3': RECIPES[10].steps[3] });
    await expect(b.revealMasteryStep(session.session_id, 0, 't')).rejects.toMatchObject({ code: 'STEP_NOT_HIDDEN' });
  });

  it('completes slot 10 with 1+ reveals or no session, without the mastery badge', async () => {
    const revealed = await masteryUser();
    const session = await revealed.startMastery(10, 't');
    await revealed.revealMasteryStep(session.session_id, 2, 't');
    const withReveals = await revealed.submitCheckIn(
      { user_recipe_id: mockUserRecipeId(10), slot_id: 10, rating: 'ok', mastery_session_id: session.session_id },
      't',
    );
    expect(withReveals.xp).toEqual({ status: 'awarded', xp_awarded: 181, is_first_completion: true, capped: false });
    const codes = withReveals.badges.status === 'ok' ? withReveals.badges.earned.map((b) => b.code) : [];
    expect(codes).toEqual(['path_weeknight_basics']);
    expect((await revealed.getBadges()).find((x) => x.code === 'mastery')?.earned).toBe(false);

    const missing = await masteryUser();
    const noSession = await missing.submitCheckIn({ user_recipe_id: mockUserRecipeId(10), slot_id: 10, rating: 'ok' }, 't');
    const missingCodes = noSession.badges.status === 'ok' ? noSession.badges.earned.map((b) => b.code) : [];
    expect(missingCodes).toEqual(['path_weeknight_basics']);
    expect((await missing.getBadges()).find((x) => x.code === 'mastery')?.earned).toBe(false);
  });

  it('a session backs one check-in; the next cook gets a fresh session', async () => {
    const b = await masteryUser();
    const session = await b.startMastery(10, 't');
    await b.submitCheckIn({ user_recipe_id: mockUserRecipeId(10), slot_id: 10, rating: 'ok', mastery_session_id: session.session_id }, 't');
    await expect(
      b.submitCheckIn({ user_recipe_id: mockUserRecipeId(10), slot_id: 10, rating: 'ok', mastery_session_id: session.session_id }, 't'),
    ).rejects.toMatchObject({ kind: 'mastery_session_used', status: 409 });
    await expect(b.revealMasteryStep(session.session_id, 2, 't')).rejects.toMatchObject({ code: 'MASTERY_SESSION_USED' });
    const next = await b.startMastery(10, 't');
    expect(next.session_id).not.toBe(session.session_id);
  });

  it('rejects a mastery session on a non-final slot', async () => {
    const b = createMockBackend({ latency: 0, startSignedIn: true });
    await b.generateRecipe(4, 't');
    await expect(b.startMastery(4, 't')).rejects.toMatchObject({ code: 'SLOT_NOT_FINAL' });
    await expect(
      b.submitCheckIn(
        { user_recipe_id: mockUserRecipeId(4), slot_id: 4, rating: 'ok', mastery_session_id: '20000000-0000-4000-8000-000000000001' },
        't',
      ),
    ).rejects.toMatchObject({ kind: 'validation', code: 'MASTERY_NOT_ALLOWED', status: 400 });
  });
});
