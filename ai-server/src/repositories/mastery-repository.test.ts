import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { MasteryError, SupabaseMasteryRepository } from './mastery-repository.js';

const mockFetch = vi.fn();
const USER_ID = randomUUID();
const SESSION_ID = randomUUID();

function ok(body: unknown): { ok: true; status: 200; text: () => Promise<string> } {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}

function pgError(status: number, message: string): { ok: false; status: number; text: () => Promise<string> } {
  return { ok: false, status, text: () => Promise.resolve(JSON.stringify({ code: 'P0001', details: null, hint: null, message })) };
}

describe('SupabaseMasteryRepository', () => {
  let repo: SupabaseMasteryRepository;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    repo = new SupabaseMasteryRepository({ url: 'https://test.supabase.co', serviceRoleKey: 'key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('start calls the RPC with the user and slot and parses revealed steps', async () => {
    mockFetch.mockResolvedValueOnce(
      ok([
        {
          session_id: SESSION_ID,
          hidden_step_indices: [0, 2],
          revealed_step_indices: [2],
          revealed_steps: { '2': { instruction: 'Rest', isSafetyStep: false } },
        },
      ])
    );
    const session = await repo.start(USER_ID, 10);
    expect(session).toEqual({
      sessionId: SESSION_ID,
      hiddenStepIndices: [0, 2],
      revealedSteps: { 2: { instruction: 'Rest', isSafetyStep: false } },
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.supabase.co/rest/v1/rpc/start_mastery_session');
    expect(JSON.parse(init.body as string)).toEqual({ p_user_id: USER_ID, p_slot_id: 10 });
  });

  it('reveal calls the RPC and returns the step', async () => {
    mockFetch.mockResolvedValueOnce(
      ok([{ step: { instruction: 'Pat dry', isSafetyStep: false }, hidden_step_indices: [0, 2], revealed_step_indices: [0] }])
    );
    const reveal = await repo.reveal(USER_ID, SESSION_ID, 0);
    expect(reveal).toEqual({
      stepIndex: 0,
      step: { instruction: 'Pat dry', isSafetyStep: false },
      hiddenStepIndices: [0, 2],
      revealedStepIndices: [0],
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.supabase.co/rest/v1/rpc/reveal_mastery_step');
    expect(JSON.parse(init.body as string)).toEqual({ p_user_id: USER_ID, p_session_id: SESSION_ID, p_step_index: 0 });
  });

  it.each(['SLOT_NOT_FINAL', 'RECIPE_NOT_FOUND', 'SLOT_LOCKED'] as const)('start maps the database refusal %s', async (code) => {
    mockFetch.mockResolvedValueOnce(pgError(400, code));
    const err = await repo.start(USER_ID, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MasteryError);
    expect((err as MasteryError).code).toBe(code);
  });

  it.each(['MASTERY_SESSION_NOT_FOUND', 'MASTERY_SESSION_USED', 'STEP_NOT_HIDDEN'] as const)('reveal maps %s', async (code) => {
    mockFetch.mockResolvedValueOnce(pgError(400, code));
    const err = await repo.reveal(USER_ID, SESSION_ID, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MasteryError);
    expect((err as MasteryError).code).toBe(code);
  });

  it('a 5xx stays an outage, not a refusal', async () => {
    mockFetch.mockResolvedValueOnce(pgError(503, 'SLOT_LOCKED'));
    const err = await repo.start(USER_ID, 10).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MasteryError);
  });

  it('rejects a malformed step from the database', async () => {
    mockFetch.mockResolvedValueOnce(ok([{ step: null, hidden_step_indices: [0], revealed_step_indices: [0] }]));
    await expect(repo.reveal(USER_ID, SESSION_ID, 0)).rejects.toThrow();
  });
});
