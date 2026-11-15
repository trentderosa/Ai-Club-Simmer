import { adjustTimer, createTimer, formatClock, parseStepDurationSeconds, pauseTimer, resetTimer, startTimer, tickTimer } from './timer';

describe('parseStepDurationSeconds', () => {
  it.each([
    ['Simmer for 5 minutes.', 300],
    ['Toss until glossy, about 1 minute.', 60],
    ['Rest 15 minutes before you carve.', 900],
    ['Roast 60 to 75 minutes, until 165°F.', 3600],
    ['Toss every 30 seconds until bright green, about 3 minutes.', 180],
    ['Bake for 1 hour.', 3600],
    ['Microwave 90 secs.', 90],
  ])('%s -> %i s', (text, secs) => {
    expect(parseStepDurationSeconds(text)).toBe(secs);
  });

  it.each(['Heat the oven to 425°F.', 'Cut into 1-inch cubes.', 'Whisk the eggs.'])('finds no timer in "%s"', (text) => {
    expect(parseStepDurationSeconds(text)).toBeNull();
  });
});

describe('formatClock', () => {
  it('formats minutes and hours', () => {
    expect(formatClock(132)).toBe('2:12');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('timer state machine', () => {
  it('counts down from the wall clock and finishes', () => {
    let t = createTimer(120);
    t = startTimer(t, 1_000);
    expect(t.status).toBe('running');
    t = tickTimer(t, 31_000);
    expect(t.remainingMs).toBe(90_000);
    t = tickTimer(t, 200_000);
    expect(t).toMatchObject({ status: 'done', remainingMs: 0 });
  });

  it('pauses and resumes without losing time', () => {
    let t = startTimer(createTimer(60), 0);
    t = pauseTimer(t, 20_000);
    expect(t).toMatchObject({ status: 'paused', remainingMs: 40_000 });
    t = startTimer(t, 100_000);
    expect(t.endsAt).toBe(140_000);
  });

  it('restarts from the full duration after it finishes, and resets', () => {
    let t = tickTimer(startTimer(createTimer(10), 0), 11_000);
    expect(t.status).toBe('done');
    t = startTimer(t, 50_000);
    expect(t.endsAt).toBe(60_000);
    expect(resetTimer(t)).toMatchObject({ status: 'idle', remainingMs: 10_000 });
  });

  it('adjusts by ±30 s and never goes below 1 s', () => {
    const t = adjustTimer(createTimer(60), 30, 0);
    expect(t.remainingMs).toBe(90_000);
    expect(adjustTimer(createTimer(20), -30, 0).remainingMs).toBe(1_000);
    const running = adjustTimer(startTimer(createTimer(60), 0), 30, 10_000);
    expect(running.endsAt).toBe(90_000);
  });
});
