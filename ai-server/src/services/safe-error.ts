/**
 * Log-safe description of an error for route logs.
 *
 * Error messages can carry a Supabase response body, model output, or user
 * text, so route logs never include them. This keeps only fields that are
 * safe by construction:
 * - `error`: the error class name (`SupabaseRestError`, `TypeError`, ...).
 * - `status`: an integer HTTP status from our own error classes.
 * - `kind`: SupabaseRestError's fixed category (http, timeout, network,
 *   invalid_response), so an outage and a slow request look different.
 * - `code`: a fixed-vocabulary code (mastery codes, XP award reasons) or a
 *   Node system code like `ECONNREFUSED` from the cause chain.
 */
import { CheckInMasterySessionError } from '../types/check-in.js';
import { MasteryError } from '../repositories/mastery-repository.js';
import { SupabaseRestError } from './supabase-rest.js';
import { XpAwardError } from './xp-awarder.js';

export interface SafeErrorFields {
  error: string;
  status?: number;
  kind?: string;
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

  if (error instanceof SupabaseRestError) fields.kind = error.kind;

  let code: string | undefined;
  if (error instanceof MasteryError || error instanceof CheckInMasterySessionError) {
    code = error.code;
  } else if (error instanceof XpAwardError) {
    code = error.reason;
  } else {
    code = safeCauseCode(error);
  }
  if (code) fields.code = code;

  return fields;
}

/** First upper-case identifier `code` on the error or its cause chain (max 5 deep). */
function safeCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
    current = cause;
  }
  return undefined;
}
