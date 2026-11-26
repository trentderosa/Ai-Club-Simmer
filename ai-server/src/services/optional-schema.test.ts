import { describe, expect, it } from 'vitest';
import { isMissingColumnError, isMissingTableError } from './optional-schema.js';
import { SupabaseRestError } from './supabase-rest.js';

const err = (status: number, code?: string): SupabaseRestError =>
  SupabaseRestError.fromResponse('x', status, code ? JSON.stringify({ code }) : '{}');

describe('isMissingTableError', () => {
  it('accepts PGRST205 and 42P01 only', () => {
    expect(isMissingTableError(err(404, 'PGRST205'))).toBe(true);
    expect(isMissingTableError(err(404, '42P01'))).toBe(true);
    expect(isMissingTableError(err(404))).toBe(false);
    expect(isMissingTableError(err(500, 'XX000'))).toBe(false);
    expect(isMissingTableError(new Error('x'))).toBe(false);
  });
});

describe('isMissingColumnError', () => {
  it('accepts only 400 with 42703', () => {
    expect(isMissingColumnError(err(400, '42703'))).toBe(true);
    expect(isMissingColumnError(err(400, 'PGRST100'))).toBe(false);
    expect(isMissingColumnError(err(400))).toBe(false);
    expect(isMissingColumnError(err(500, '42703'))).toBe(false);
    expect(isMissingColumnError(new Error('x'))).toBe(false);
  });
});
