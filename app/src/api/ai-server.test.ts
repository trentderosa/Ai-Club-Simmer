import { CHECK_IN_TIMEOUT_MS, RECIPE_TIMEOUT_MS, createAiServerClient, parseResponse } from './ai-server';
import { ApiError } from './errors';
import { CheckInResponseSchema, RecipeResponseSchema } from './schemas';

/** A minimal stand-in for fetch's Response. */
function res(status: number, body: unknown, { json = true } = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (!json) throw new SyntaxError('Unexpected token <');
      return body;
    },
  } as unknown as Response;
}

const recipe = {
  title: 'Fluffy Scrambled Eggs',
  ingredients: [{ name: 'eggs', amount: '2' }],
  timeEstimateMinutes: 10,
  steps: [{ instruction: 'Whisk the eggs.', isSafetyStep: false, techniqueName: 'Whisk eggs' }],
};

async function kindOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return (e as ApiError).kind;
  }
  throw new Error('expected an ApiError');
}

describe('parseResponse: recipe', () => {
  it('parses a generated recipe with partial videos', async () => {
    const videos = { 'Whisk eggs': { videoId: 'abc123XYZ_-', title: 'How to whisk eggs', channelTitle: 'x' } };
    const out = await parseResponse(res(200, { recipe, cached: false, videos }), RecipeResponseSchema, 'recipe');
    expect(out.recipe.title).toBe('Fluffy Scrambled Eggs');
    expect(out.videos['Whisk eggs'].videoId).toBe('abc123XYZ_-');
  });

  it('treats null or missing videos as {}', async () => {
    expect((await parseResponse(res(200, { recipe, cached: true, videos: null }), RecipeResponseSchema, 'recipe')).videos).toEqual({});
    expect((await parseResponse(res(200, { recipe, cached: true }), RecipeResponseSchema, 'recipe')).videos).toEqual({});
  });

  it('keeps an optional coach note', async () => {
    const out = await parseResponse(res(200, { recipe: { ...recipe, coachNote: 'Keep it low.' }, cached: true, videos: {} }), RecipeResponseSchema, 'recipe');
    expect(out.recipe.coachNote).toBe('Keep it low.');
  });

  it('rejects a body that does not match the contract', async () => {
    expect(await kindOf(parseResponse(res(200, { recipe: { title: 'x' } }), RecipeResponseSchema, 'recipe'))).toBe('bad_response');
  });

  it.each([
    [401, { error: 'Invalid or expired token' }, 'unauthorized'],
    [403, { error: 'locked', code: 'SLOT_LOCKED' }, 'slot_locked'],
    [404, { error: 'User profile not found. Please complete onboarding first.' }, 'onboarding_required'],
    [404, { error: 'Path slot 99 not found' }, 'not_found'],
    [429, { error: 'Too many requests' }, 'rate_limited'],
    [500, { error: 'Recipe generation failed. Please try again.', attempts: 3 }, 'generation_failed'],
    [503, { error: 'Authentication service temporarily unavailable' }, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, body, kind) => {
    expect(await kindOf(parseResponse(res(status, body), RecipeResponseSchema, 'recipe'))).toBe(kind);
  });

  it('handles a non-JSON error page', async () => {
    expect(await kindOf(parseResponse(res(502, null, { json: false }), RecipeResponseSchema, 'recipe'))).toBe('server');
  });
});

describe('parseResponse: check-in', () => {
  const base = { check_in_id: 'c1', coach_note: 'Nice work!', badges: { status: 'ok', earned: [] }, suggest_repeat: false };

  it('parses an awarded result', async () => {
    const out = await parseResponse(
      res(201, { ...base, focus_area: 'heat control', xp: { status: 'awarded', xp_awarded: 62, is_first_completion: true, capped: false } }),
      CheckInResponseSchema,
      'check-in',
    );
    expect(out.xp).toEqual({ status: 'awarded', xp_awarded: 62, is_first_completion: true, capped: false });
  });

  it('parses failed and skipped XP without numbers', async () => {
    const failed = await parseResponse(res(201, { ...base, xp: { status: 'failed' }, badges: { status: 'failed' } }), CheckInResponseSchema, 'check-in');
    expect(failed.xp.status).toBe('failed');
    expect('xp_awarded' in failed.xp).toBe(false);
    const skipped = await parseResponse(res(201, { ...base, xp: { status: 'skipped' } }), CheckInResponseSchema, 'check-in');
    expect(skipped.xp.status).toBe('skipped');
  });

  it('maps check-in 400s and 500s', async () => {
    expect(await kindOf(parseResponse(res(400, { error: 'x', code: 'INVALID_RECIPE' }), CheckInResponseSchema, 'check-in'))).toBe('invalid_recipe');
    expect(await kindOf(parseResponse(res(400, { error: 'Validation failed', code: 'VALIDATION_ERROR' }), CheckInResponseSchema, 'check-in'))).toBe('validation');
    expect(await kindOf(parseResponse(res(409, { error: 'idempotency_key was already used for a different check-in', code: 'IDEMPOTENCY_CONFLICT' }), CheckInResponseSchema, 'check-in'))).toBe('validation');
    // A check-in 500 is a plain server error, not "generation failed".
    expect(await kindOf(parseResponse(res(500, { error: 'Internal server error' }), CheckInResponseSchema, 'check-in'))).toBe('server');
  });
});

describe('createAiServerClient', () => {
  it('posts to the contract paths with the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.includes('/recipes/')
        ? res(200, { recipe, cached: true, videos: {} })
        : res(201, { check_in_id: 'c', coach_note: 'n', xp: { status: 'skipped' }, badges: { status: 'skipped' }, suggest_repeat: false });
    }) as unknown as typeof fetch;
    const client = createAiServerClient('http://127.0.0.1:3001', fakeFetch);

    await client.generateRecipe(4, 'tok');
    const body = {
      user_recipe_id: '00000000-0000-4000-8000-000000000004',
      slot_id: 4,
      rating: 'ok' as const,
      idempotency_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    await client.submitCheckIn(body, 'tok');

    expect(calls[0].url).toBe('http://127.0.0.1:3001/api/recipes/generate/4');
    expect(calls[1].url).toBe('http://127.0.0.1:3001/api/check-ins');
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    }
    expect(JSON.parse(String(calls[1].init.body))).toEqual(body);
  });

  it('turns a failed fetch into a network error', async () => {
    const client = createAiServerClient('http://x', (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch);
    expect(await kindOf(client.generateRecipe(1, 't'))).toBe('network');
  });

  it('refuses to call without a base URL', async () => {
    expect(await kindOf(createAiServerClient('').generateRecipe(1, 't'))).toBe('config');
  });
});

describe('ai-server timeouts', () => {
  it('waits out the server\'s worst-case Ollama budget', () => {
    // 3 attempts × 60s, plus video budget / pre-note work. The previous
    // check-in timeout (30s) was shorter than a single Ollama attempt.
    expect(RECIPE_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * 60_000 + 8_000);
    expect(CHECK_IN_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it('turns an aborted fetch into a network timeout error', async () => {
    const client = createAiServerClient(
      'http://x',
      (async (_url: string, init?: RequestInit) => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        // If a signal is provided, mark the same abort path the real client uses.
        if (init?.signal?.aborted) throw err;
        throw err;
      }) as unknown as typeof fetch,
    );
    const e = await client.generateRecipe(1, 't').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe('network');
  });
});
