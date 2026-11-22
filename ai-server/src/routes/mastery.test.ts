import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createMasteryRouter } from './mastery.js';
import { MasteryError, type MasteryRepository } from '../repositories/mastery-repository.js';
import type { JwtVerifier } from '../services/jwt-verifier.js';

const USER_ID = randomUUID();
const SESSION_ID = randomUUID();

function setup(repo: Partial<MasteryRepository> = {}, verifier?: JwtVerifier): { app: express.Express; repo: MasteryRepository } {
  const masteryRepository: MasteryRepository = {
    start: vi.fn().mockResolvedValue({
      sessionId: SESSION_ID,
      hiddenStepIndices: [0, 2],
      revealedSteps: { 2: { instruction: 'Rest 10 minutes', isSafetyStep: false } },
    }),
    reveal: vi.fn().mockResolvedValue({
      stepIndex: 0,
      step: { instruction: 'Pat the chicken dry', isSafetyStep: false },
      hiddenStepIndices: [0, 2],
      revealedStepIndices: [0, 2],
    }),
    ...repo,
  };
  const jwtVerifier = verifier ?? { verify: vi.fn().mockResolvedValue({ valid: true, userId: USER_ID }) };
  const app = express();
  app.use(express.json());
  app.use('/api/mastery', createMasteryRouter({ jwtVerifier, masteryRepository }, { rateLimit: { windowMs: 60000, maxRequests: 100 } }));
  return { app, repo: masteryRepository };
}

const auth = { Authorization: 'Bearer t' };

describe('POST /api/mastery/sessions', () => {
  it('starts or resumes a session for the authenticated user', async () => {
    const { app, repo } = setup();
    const res = await request(app).post('/api/mastery/sessions').set(auth).send({ slot_id: 10 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      session_id: SESSION_ID,
      hidden_step_indices: [0, 2],
      revealed_steps: { '2': { instruction: 'Rest 10 minutes', isSafetyStep: false } },
    });
    expect(repo.start).toHaveBeenCalledWith(USER_ID, 10);
  });

  it('needs a valid login', async () => {
    const { app, repo } = setup({}, { verify: vi.fn().mockResolvedValue({ valid: false, error: 'invalid' }) });
    expect((await request(app).post('/api/mastery/sessions').send({ slot_id: 10 })).status).toBe(401);
    expect((await request(app).post('/api/mastery/sessions').set(auth).send({ slot_id: 10 })).status).toBe(401);
    expect(repo.start).not.toHaveBeenCalled();
  });

  it('validates slot_id', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/mastery/sessions').set(auth).send({ slot_id: 'ten' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['SLOT_NOT_FINAL', 400],
    ['RECIPE_NOT_FOUND', 404],
    ['SLOT_LOCKED', 403],
  ] as const)('maps %s to %i', async (code, status) => {
    const { app } = setup({ start: vi.fn().mockRejectedValue(new MasteryError(code)) });
    const res = await request(app).post('/api/mastery/sessions').set(auth).send({ slot_id: 10 });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('an outage is a 500 without details', async () => {
    const { app } = setup({ start: vi.fn().mockRejectedValue(new Error('Supabase rpc timed out')) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(app).post('/api/mastery/sessions').set(auth).send({ slot_id: 10 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    spy.mockRestore();
  });
});

describe('POST /api/mastery/sessions/:id/reveal', () => {
  it('returns the revealed step', async () => {
    const { app, repo } = setup();
    const res = await request(app).post(`/api/mastery/sessions/${SESSION_ID}/reveal`).set(auth).send({ step_index: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      step_index: 0,
      step: { instruction: 'Pat the chicken dry', isSafetyStep: false },
      hidden_step_indices: [0, 2],
      revealed_step_indices: [0, 2],
    });
    expect(repo.reveal).toHaveBeenCalledWith(USER_ID, SESSION_ID, 0);
  });

  it('validates the session id and step index', async () => {
    const { app, repo } = setup();
    expect((await request(app).post('/api/mastery/sessions/nope/reveal').set(auth).send({ step_index: 0 })).status).toBe(400);
    expect((await request(app).post(`/api/mastery/sessions/${SESSION_ID}/reveal`).set(auth).send({ step_index: -1 })).status).toBe(400);
    expect((await request(app).post(`/api/mastery/sessions/${SESSION_ID}/reveal`).set(auth).send({})).status).toBe(400);
    expect(repo.reveal).not.toHaveBeenCalled();
  });

  it.each([
    ['MASTERY_SESSION_NOT_FOUND', 404],
    ['MASTERY_SESSION_USED', 409],
    ['STEP_NOT_HIDDEN', 400],
  ] as const)('maps %s to %i', async (code, status) => {
    const { app } = setup({ reveal: vi.fn().mockRejectedValue(new MasteryError(code)) });
    const res = await request(app).post(`/api/mastery/sessions/${SESSION_ID}/reveal`).set(auth).send({ step_index: 1 });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('per-IP limiter before auth', () => {
  it('rate-limits unauthenticated requests after the cap', async () => {
    const masteryRepository = { start: vi.fn(), reveal: vi.fn() } as unknown as MasteryRepository;
    const verify = vi.fn().mockResolvedValue({ valid: false, error: 'invalid' });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/mastery',
      createMasteryRouter(
        { jwtVerifier: { verify }, masteryRepository },
        { ipRateLimit: { windowMs: 60000, maxRequests: 2 } }
      )
    );
    expect((await request(app).post('/api/mastery/sessions').send({ slot_id: 10 })).status).toBe(401);
    expect((await request(app).post('/api/mastery/sessions').send({ slot_id: 10 })).status).toBe(401);
    const limited = await request(app).post('/api/mastery/sessions').send({ slot_id: 10 });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, please try again later' });
    expect((await request(app).post('/api/mastery/sessions/x/reveal').send({})).status).toBe(429);
  });
});
