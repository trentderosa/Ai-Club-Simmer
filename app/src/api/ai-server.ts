/**
 * Typed client for the Simmer ai-server (see docs/CLIENT_API.md).
 *
 * Every call sends the user's Supabase access token as a bearer token. The
 * app never holds the server-only Supabase or YouTube keys; the server does.
 */
import type { z } from 'zod';

import { CHECK_IN_TIMEOUT_MS, RECIPE_TIMEOUT_MS } from '../domain/check-in-retry';
import { ApiError, kindForHttpError, parseRetryAfterSeconds, type ApiRoute } from './errors';
import {
  ApiErrorBodySchema,
  CheckInResponseSchema,
  RecipeResponseSchema,
  CookAnythingResponseSchema,
  DishPhotosResponseSchema,
  MasteryRevealResponseSchema,
  MasteryStartResponseSchema,
  type CheckInInput,
  type MasteryRevealResponse,
  type MasteryStartResponse,
  type CheckInResponse,
  type RecipeResponse,
  type CookAnythingResponse,
  type DishPhoto,
} from './schemas';

export { CHECK_IN_TIMEOUT_MS, RECIPE_TIMEOUT_MS };

export interface AiServerClient {
  generateRecipe(slotId: number, accessToken: string): Promise<RecipeResponse>;
  submitCheckIn(input: CheckInInput, accessToken: string): Promise<CheckInResponse>;
  cookAnything(dish: string, accessToken: string): Promise<CookAnythingResponse>;
  dishPhotos(names: string[], accessToken: string): Promise<Record<string, DishPhoto | null>>;
  startMastery(slotId: number, accessToken: string): Promise<MasteryStartResponse>;
  revealMasteryStep(sessionId: string, stepIndex: number, accessToken: string): Promise<MasteryRevealResponse>;
}

/** Mastery calls are small single-row updates; they should answer fast. */
export const MASTERY_TIMEOUT_MS = 15_000;

type FetchFn = typeof fetch;

export function createAiServerClient(baseUrl: string, fetchFn: FetchFn = fetch): AiServerClient {
  async function post<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    accessToken: string,
    schema: S,
    route: ApiRoute,
    timeoutMs: number,
  ): Promise<z.infer<S>> {
    if (!baseUrl) throw new ApiError('config', 'EXPO_PUBLIC_AI_SERVER_URL is not set.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (e) {
      const timedOut = controller.signal.aborted;
      throw new ApiError(
        timedOut ? 'timeout' : 'network',
        timedOut ? 'The AI server took too long to answer.' : `Can't reach the AI server. ${String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return parseResponse(res, schema, route);
  }

  return {
    generateRecipe: (slotId, token) =>
      post(`/api/recipes/generate/${slotId}`, {}, token, RecipeResponseSchema, 'recipe', RECIPE_TIMEOUT_MS),
    submitCheckIn: (input, token) =>
      post('/api/check-ins', input, token, CheckInResponseSchema, 'check-in', CHECK_IN_TIMEOUT_MS),
    cookAnything: (dish, token) =>
      post('/api/recipes/cook-anything', { dish }, token, CookAnythingResponseSchema, 'recipe', RECIPE_TIMEOUT_MS),
    dishPhotos: async (names, token) => {
      const parsed = await post('/api/dish-photos', { dishes: names }, token, DishPhotosResponseSchema, 'recipe', 8000);
      return parsed.photos;
    },
    startMastery: (slotId, token) =>
      post('/api/mastery/sessions', { slot_id: slotId }, token, MasteryStartResponseSchema, 'mastery', MASTERY_TIMEOUT_MS),
    revealMasteryStep: (sessionId, stepIndex, token) =>
      post(
        `/api/mastery/sessions/${encodeURIComponent(sessionId)}/reveal`,
        { step_index: stepIndex },
        token,
        MasteryRevealResponseSchema,
        'mastery',
        MASTERY_TIMEOUT_MS,
      ),
  };
}

/** Turns a fetch Response into parsed data or an ApiError. Exported for tests. */
export async function parseResponse<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  route: ApiRoute,
): Promise<z.infer<S>> {
  let json: unknown = undefined;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body (proxy error page, empty body). Handled below.
  }
  if (!res.ok) {
    const body = ApiErrorBodySchema.safeParse(json);
    const message = (body.success && body.data.error) || `Request failed (${res.status}).`;
    const code = body.success ? body.data.code : undefined;
    const kind = kindForHttpError(res.status, code, message, route);
    const retryAfter = kind === 'busy' ? parseRetryAfterSeconds(res.headers?.get('Retry-After')) : undefined;
    throw new ApiError(kind, message, res.status, code, retryAfter);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('bad_response', `Unexpected response from the AI server: ${parsed.error.message}`, res.status);
  }
  return parsed.data;
}
