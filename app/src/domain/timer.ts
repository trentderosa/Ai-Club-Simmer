/**
 * Cook-mode timer logic, kept free of React so it can be unit tested.
 *
 * Recipes don't carry a timer field, so the duration is read from the step
 * text ("Simmer for 5 minutes", "about 3 minutes"). When a step mentions
 * several, the longest one wins ("Toss every 30 seconds ... about 3 minutes").
 */

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };
const DURATION_RE =
  /(\d+(?:\.\d+)?|½)\s*(?:(?:to|-|–|or)\s*\d+(?:\.\d+)?\s*)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;

export function parseStepDurationSeconds(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(DURATION_RE)) {
    const n = m[1] === '½' ? 0.5 : Number(m[1]);
    const secs = Math.round(n * UNIT_SECONDS[m[2][0].toLowerCase()]);
    if (secs > 0 && (best === null || secs > best)) best = secs;
  }
  return best;
}

/** 132 -> "2:12", 3725 -> "1:02:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export type TimerStatus = 'idle' | 'running' | 'paused' | 'done';

export interface TimerState {
  durationMs: number;
  /** Left as of the last pause/tick; while running, the truth is `endsAt - now`. */
  remainingMs: number;
  status: TimerStatus;
  endsAt: number | null;
}

export const createTimer = (durationSeconds: number): TimerState => ({
  durationMs: durationSeconds * 1000,
  remainingMs: durationSeconds * 1000,
  status: 'idle',
  endsAt: null,
});

export function startTimer(t: TimerState, now: number): TimerState {
  if (t.status === 'running') return t;
  const remaining = t.status === 'done' ? t.durationMs : t.remainingMs;
  return { ...t, status: 'running', remainingMs: remaining, endsAt: now + remaining };
}

export function pauseTimer(t: TimerState, now: number): TimerState {
  if (t.status !== 'running' || t.endsAt === null) return t;
  return { ...t, status: 'paused', remainingMs: Math.max(0, t.endsAt - now), endsAt: null };
}

export function resetTimer(t: TimerState): TimerState {
  return createTimer(t.durationMs / 1000);
}

/** Recomputes remaining time from the wall clock, so a slow tick never drifts. */
export function tickTimer(t: TimerState, now: number): TimerState {
  if (t.status !== 'running' || t.endsAt === null) return t;
  const left = t.endsAt - now;
  if (left <= 0) return { ...t, status: 'done', remainingMs: 0, endsAt: null };
  return { ...t, remainingMs: left };
}

/** Adds (or removes) time; never below zero. Works in any state. */
export function adjustTimer(t: TimerState, deltaSeconds: number, now: number): TimerState {
  const delta = deltaSeconds * 1000;
  if (t.status === 'running' && t.endsAt !== null) {
    const endsAt = Math.max(now, t.endsAt + delta);
    return { ...t, endsAt, remainingMs: endsAt - now, durationMs: Math.max(1000, t.durationMs + delta) };
  }
  const remaining = Math.max(1000, (t.status === 'done' ? 0 : t.remainingMs) + delta);
  return { ...t, remainingMs: remaining, durationMs: Math.max(1000, t.durationMs + delta), status: t.status === 'done' ? 'paused' : t.status };
}
