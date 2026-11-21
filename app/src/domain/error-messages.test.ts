import { ApiError } from '../api/errors';
import { errorCopy, isAiServerOutage } from './error-messages';

describe('errorCopy outage messages', () => {
  it('tells an unreachable caller that the laptop and tunnel have to be running', () => {
    const copy = errorCopy(new ApiError('network', "Can't reach the AI server. TypeError: Failed to fetch"));
    expect(copy).toEqual({
      title: 'Can’t reach the kitchen',
      body: 'Check your connection. The AI server laptop and its tunnel have to be running.',
      action: 'retry',
    });
    expect(copy.body).not.toContain('TypeError');
    expect(copy.body).not.toContain('same network');
  });

  it('uses a timeout message instead of the unreachable one', () => {
    const copy = errorCopy(new ApiError('timeout', 'The AI server took too long to answer.'));
    expect(copy).toEqual({
      title: 'This is taking too long',
      body: 'The AI server didn’t answer in time. Try again in a moment.',
      action: 'retry',
    });
  });

  it('keeps the existing 429 message and a retry', () => {
    expect(errorCopy(new ApiError('rate_limited', 'Too many requests', 429))).toEqual({
      title: 'Slow down a little',
      body: 'Too many requests in a short time. Wait a minute, then try again.',
      action: 'retry',
    });
  });

  it('treats AUTH_UNAVAILABLE as sign-in even when the message is reworded, and a kitchen 503 without the code as the kitchen', () => {
    expect(errorCopy(new ApiError('unavailable', 'Login could not be checked just now.', 503, 'AUTH_UNAVAILABLE'))).toEqual({
      title: 'Sign-in service is down',
      body: 'The server couldn’t check your login just now. Try again in a moment.',
      action: 'retry',
    });
    expect(errorCopy(new ApiError('unavailable', 'The kitchen is temporarily unavailable.', 503))).toEqual({
      title: 'The kitchen is unavailable',
      body: 'The AI server can’t take that request right now. Try again in a moment.',
      action: 'retry',
    });
    // A different code wins over the old wording. The wording match is only for a body with no code.
    expect(
      errorCopy(new ApiError('unavailable', 'Authentication service temporarily unavailable', 503, 'KITCHEN_DOWN')),
    ).toEqual({
      title: 'The kitchen is unavailable',
      body: 'The AI server can’t take that request right now. Try again in a moment.',
      action: 'retry',
    });
  });

  it('keeps the sign-in message for the server’s exact auth 503 text', () => {
    // Older servers omit `code`. Check-in, mastery, and dish photos say the first;
    // recipe and Cook anything say the second.
    const messages = ['Authentication service unavailable', 'Authentication service temporarily unavailable'];
    for (const message of messages) {
      expect(errorCopy(new ApiError('unavailable', message, 503))).toEqual({
        title: 'Sign-in service is down',
        body: 'The server couldn’t check your login just now. Try again in a moment.',
        action: 'retry',
      });
    }
  });

  it('says the kitchen is unavailable for a plain 503', () => {
    expect(errorCopy(new ApiError('unavailable', 'Request failed (503).', 503))).toEqual({
      title: 'The kitchen is unavailable',
      body: 'The AI server can’t take that request right now. Try again in a moment.',
      action: 'retry',
    });
  });

  it('says new recipes are paused when the generation limit cannot be checked', () => {
    expect(
      errorCopy(
        new ApiError(
          'server',
          'New recipes are temporarily unavailable. Try a dish you already saved, or try again later.',
          503,
          'GENERATION_RATE_LIMIT_UNAVAILABLE',
        ),
      ),
    ).toEqual({
      title: 'New recipes are paused',
      body: 'The kitchen can’t start a new recipe right now. Try again in a moment, or open a dish you already saved.',
      action: 'retry',
    });
  });

  it('leaves a normal server error on the existing message', () => {
    expect(errorCopy(new ApiError('server', 'Internal server error', 500)).title).toBe('Something went wrong');
  });
});

describe('errorCopy: GENERATION_BUSY', () => {
  const busy = (seconds?: number) => new ApiError('busy', 'The kitchen is busy right now.', 503, 'GENERATION_BUSY', seconds);

  it.each([
    [undefined, 'The kitchen is busy right now. Try again in a minute.'],
    [1, 'The kitchen is busy right now. Try again in about 1 second.'],
    [30, 'The kitchen is busy right now. Try again in about 30 seconds.'],
    [59, 'The kitchen is busy right now. Try again in about 59 seconds.'],
    [60, 'The kitchen is busy right now. Try again in about 1 minute.'],
    [89, 'The kitchen is busy right now. Try again in about 1 minute.'],
    [90, 'The kitchen is busy right now. Try again in about 2 minutes.'],
    [120, 'The kitchen is busy right now. Try again in about 2 minutes.'],
    [300, 'The kitchen is busy right now. Try again in about 5 minutes.'],
  ])('with %s seconds says: %s', (seconds, body) => {
    expect(errorCopy(busy(seconds))).toEqual({ title: 'The kitchen is busy', body, action: 'retry' });
  });

  it('counts as an AI server outage', () => {
    expect(isAiServerOutage(busy(30))).toBe(true);
  });

  it('keeps a 503 without the code as the kitchen and an auth 503 as sign-in', () => {
    expect(errorCopy(new ApiError('unavailable', 'Request failed (503).', 503)).title).toBe('The kitchen is unavailable');
    expect(errorCopy(new ApiError('unavailable', 'Login could not be checked.', 503, 'AUTH_UNAVAILABLE')).title).toBe(
      'Sign-in service is down',
    );
  });
});

describe('isAiServerOutage', () => {
  it('matches unreachable, timeout, 429, and 503 only', () => {
    expect(isAiServerOutage(new ApiError('network', 'down'))).toBe(true);
    expect(isAiServerOutage(new ApiError('timeout', 'slow'))).toBe(true);
    expect(isAiServerOutage(new ApiError('rate_limited', 'slow down', 429))).toBe(true);
    expect(isAiServerOutage(new ApiError('unavailable', 'Request failed (503).', 503))).toBe(true);
    expect(isAiServerOutage(new ApiError('server', 'limit store down', 503, 'GENERATION_RATE_LIMIT_UNAVAILABLE'))).toBe(true);
    expect(isAiServerOutage(new ApiError('server', 'Internal server error', 500))).toBe(false);
    expect(isAiServerOutage(new ApiError('generation_failed', 'bad recipe', 500))).toBe(false);
    expect(isAiServerOutage(new ApiError('slot_locked', 'locked', 403, 'SLOT_LOCKED'))).toBe(false);
    expect(isAiServerOutage(new Error('nope'))).toBe(false);
  });
});
