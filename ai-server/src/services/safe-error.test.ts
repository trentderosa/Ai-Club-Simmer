import { describe, expect, it } from 'vitest';
import { safeErrorFields } from './safe-error.js';
import { SupabaseRestError } from './supabase-rest.js';
import { XpAwardError } from './xp-awarder.js';
import { MasteryError } from '../repositories/mastery-repository.js';
import { CheckInMasterySessionError } from '../types/check-in.js';

describe('safeErrorFields', () => {
  it('keeps the HTTP status of a Supabase error but never its message (which holds the response body)', () => {
    const error = new SupabaseRestError(
      'Supabase insert failed: 409 {"details":"Key (email)=(cook@simmer.invalid) already exists"}',
      409
    );
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ error: 'SupabaseRestError', status: 409, kind: 'http' });
    expect(JSON.stringify(fields)).not.toContain('cook@simmer.invalid');
  });

  it('keeps the Postgres code of a Supabase error built from a response', () => {
    const error = SupabaseRestError.fromResponse(
      'Supabase insert failed',
      409,
      '{"code":"23505","details":"Key (email)=(cook@simmer.invalid) already exists"}'
    );
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ error: 'SupabaseRestError', status: 409, kind: 'http', code: '23505' });
    expect(JSON.stringify(fields)).not.toContain('cook@simmer.invalid');
  });

  it('omits status when a Supabase error has none (timeout or network)', () => {
    expect(
      safeErrorFields(new SupabaseRestError('Supabase read timed out after 5000ms', undefined, { kind: 'timeout' }))
    ).toEqual({ error: 'SupabaseRestError', kind: 'timeout' });
    expect(safeErrorFields(new SupabaseRestError('rpc returned a non-boolean'))).toEqual({
      error: 'SupabaseRestError',
      kind: 'invalid_response',
    });
  });

  it('keeps the XP award reason and status', () => {
    expect(safeErrorFields(new XpAwardError('http', 'award failed: body text', 503))).toEqual({
      error: 'XpAwardError',
      status: 503,
      code: 'http',
    });
  });

  it('keeps mastery and mastery-session codes', () => {
    expect(safeErrorFields(new MasteryError('SLOT_LOCKED'))).toEqual({ error: 'MasteryError', code: 'SLOT_LOCKED' });
    expect(safeErrorFields(new CheckInMasterySessionError('MASTERY_SESSION_USED'))).toEqual({
      error: 'CheckInMasterySessionError',
      code: 'MASTERY_SESSION_USED',
    });
  });

  it('keeps a Node system code from the cause chain', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
    });
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ error: 'TypeError', code: 'ECONNREFUSED' });
    expect(JSON.stringify(fields)).not.toContain('10.0.0.5');
  });

  it('keeps the network cause code of a wrapped Supabase failure', () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' }),
    });
    const error = new SupabaseRestError('Supabase read request failed: fetch failed', undefined, {
      kind: 'network',
      cause: fetchError,
    });
    expect(safeErrorFields(error)).toEqual({ error: 'SupabaseRestError', kind: 'network', code: 'ECONNREFUSED' });
  });

  it('skips an unsafe outer code and finds a safe one deeper in the chain', () => {
    const error = Object.assign(new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ETIMEDOUT' }) }), {
      code: 'not safe',
    });
    expect(safeErrorFields(error)).toEqual({ error: 'Error', code: 'ETIMEDOUT' });
  });

  it('drops a code that is not an upper-case identifier', () => {
    const error = Object.assign(new Error('boom'), { code: 'user typed cook@simmer.invalid' });
    expect(safeErrorFields(error)).toEqual({ error: 'Error' });
  });

  it('handles non-Error throws', () => {
    expect(safeErrorFields('raw string with secrets')).toEqual({ error: 'unknown' });
    expect(safeErrorFields(undefined)).toEqual({ error: 'unknown' });
  });
});
