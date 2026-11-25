/**
 * Log-safe description of an error for route logs.
 *
 * Error messages can carry a Supabase response body, model output, or user
 * text, so route logs never include them. This keeps only fields that are
 * safe by construction:
 * - `error`: the error class name (`SupabaseRestError`, `TypeError`, ...).
 * - `status`: an integer HTTP status from our own error classes.
 * - `code`: a fixed-vocabulary code (mastery codes, XP award reasons) or a
 *   Node system code like `ECONNREFUSED` from the cause chain.
 */
import { CheckInMasterySessionError } from '../types/check-in.js';
import { MasteryError } from '../repositories/mastery-repository.js';
import { errorCauseCode } from './generation-failure.js';
import { SupabaseRestError } from './supabase-rest.js';
import { XpAwardError } from './xp-awarder.js';

export interface SafeErrorFields {
  error: string;
  status?: number;
  code?: string;
}

/** Upper-case identifiers only (ECONNREFUSED, PGRST202, SLOT_LOCKED). */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

export function safeErrorFields(error: unknown): SafeErrorFields {
  const fields: SafeErrorFields = { error: error instanceof Error ? error.name : 'unknown' };

  if (
    (error instanceof SupabaseRestError || error instanceof XpAwardError) &&
    Number.isInteger(error.status)
  ) {
    fields.status = error.status;
  }

  let code: string | undefined;
  if (error instanceof MasteryError || error instanceof CheckInMasterySessionError) {
    code = error.code;
  } else if (error instanceof XpAwardError) {
    code = error.reason;
  } else {
    const cause = errorCauseCode(error);
    if (cause && SAFE_CODE.test(cause)) code = cause;
  }
  if (code) fields.code = code;

  return fields;
}
