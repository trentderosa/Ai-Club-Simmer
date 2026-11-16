import { z } from 'zod';
import { RecipeStepSchema, type Recipe } from '../schemas/recipe.js';
import { SupabaseRest, SupabaseRestError, type SupabaseRestConfig } from '../services/supabase-rest.js';

/**
 * F8 mastery sessions (server-side reveals). Backed by start_mastery_session()
 * and reveal_mastery_step() in 20261116000000_mastery_sessions.sql, which the
 * ai-server calls with the service role.
 */

export type RecipeStep = Recipe['steps'][number];

export interface MasterySession {
  sessionId: string;
  hiddenStepIndices: number[];
  /** Full content of the steps already revealed in this session, by index. */
  revealedSteps: Record<number, RecipeStep>;
}

export interface MasteryReveal {
  stepIndex: number;
  step: RecipeStep;
  hiddenStepIndices: number[];
  revealedStepIndices: number[];
}

export const MASTERY_ERROR_CODES = [
  'SLOT_NOT_FINAL',
  'RECIPE_NOT_FOUND',
  'SLOT_LOCKED',
  'MASTERY_SESSION_NOT_FOUND',
  'MASTERY_SESSION_USED',
  'STEP_NOT_HIDDEN',
] as const;

export type MasteryErrorCode = (typeof MASTERY_ERROR_CODES)[number];

/** An expected refusal from the database (not an outage). */
export class MasteryError extends Error {
  constructor(readonly code: MasteryErrorCode) {
    super(code);
    this.name = 'MasteryError';
  }
}

export interface MasteryRepository {
  /** Resume the user's open session for the slot, or start one. */
  start(userId: string, slotId: number): Promise<MasterySession>;
  /** Record a reveal (idempotent) and return that step's full content. */
  reveal(userId: string, sessionId: string, stepIndex: number): Promise<MasteryReveal>;
}

const StartRowSchema = z.object({
  session_id: z.string().uuid(),
  hidden_step_indices: z.array(z.number().int()),
  revealed_step_indices: z.array(z.number().int()),
  revealed_steps: z.record(z.string(), RecipeStepSchema).nullable(),
});

const RevealRowSchema = z.object({
  step: RecipeStepSchema,
  hidden_step_indices: z.array(z.number().int()),
  revealed_step_indices: z.array(z.number().int()),
});

/** Map a PostgREST error whose message is one of our RAISE codes. */
function toMasteryError(error: unknown): unknown {
  if (!(error instanceof SupabaseRestError) || error.status === undefined || error.status >= 500) return error;
  const code = MASTERY_ERROR_CODES.find((c) => error.message.includes(`"message":"${c}"`));
  return code ? new MasteryError(code) : error;
}

function firstRow(rows: unknown): unknown {
  return Array.isArray(rows) ? rows[0] : rows;
}

export class SupabaseMasteryRepository implements MasteryRepository {
  private readonly rest: SupabaseRest;

  constructor(config: SupabaseRestConfig) {
    this.rest = new SupabaseRest(config);
  }

  async start(userId: string, slotId: number): Promise<MasterySession> {
    let rows: unknown;
    try {
      rows = await this.rest.rpc<unknown>('start_mastery_session', { p_user_id: userId, p_slot_id: slotId });
    } catch (error) {
      throw toMasteryError(error);
    }
    const row = StartRowSchema.parse(firstRow(rows));
    const revealedSteps: Record<number, RecipeStep> = {};
    for (const [key, step] of Object.entries(row.revealed_steps ?? {})) {
      revealedSteps[Number(key)] = step;
    }
    return { sessionId: row.session_id, hiddenStepIndices: row.hidden_step_indices, revealedSteps };
  }

  async reveal(userId: string, sessionId: string, stepIndex: number): Promise<MasteryReveal> {
    let rows: unknown;
    try {
      rows = await this.rest.rpc<unknown>('reveal_mastery_step', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_step_index: stepIndex,
      });
    } catch (error) {
      throw toMasteryError(error);
    }
    const row = RevealRowSchema.parse(firstRow(rows));
    return {
      stepIndex,
      step: row.step,
      hiddenStepIndices: row.hidden_step_indices,
      revealedStepIndices: row.revealed_step_indices,
    };
  }
}
