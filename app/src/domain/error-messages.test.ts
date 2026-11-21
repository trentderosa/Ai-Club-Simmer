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

  it('keeps the sign-in message for the server’s exact auth 503 text', () => {
    // These 503s have no `code`. Check-in, mastery, and dish photos say the first;
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
