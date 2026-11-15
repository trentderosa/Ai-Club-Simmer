/**
 * Typed client for the Simmer ai-server (see docs/CLIENT_API.md).
 *
 * Every call sends the user's Supabase access token as a bearer token. The
 * app never holds the server-only Supabase or YouTube keys; the server does.
 */
import type { z } from 'zod';

import { CHECK_IN_TIMEOUT_MS, RECIPE_TIMEOUT_MS } from '../domain/check-in-retry';
import { ApiError, kindForHttpError } from './errors';
import {
  ApiErrorBodySchema,
  CheckInResponseSchema,
  RecipeResponseSchema,
  CookAnythingResponseSchema,
  type CheckInInput,
  type CheckInResponse,
  type RecipeResponse,
  type CookAnythingResponse,
} from './schemas';

export { CHECK_IN_TIMEOUT_MS, RECIPE_TIMEOUT_MS };

export interface AiServerClient {
  generateRecipe(slotId: number, accessToken: string): Promise<RecipeResponse>;
  submitCheckIn(input: CheckInInput, accessToken: string): Promise<CheckInResponse>;
  cookAnything(dish: string, accessToken: string): Promise<CookAnythingResponse>;
}

type FetchFn = typeof fetch;

export function createAiServerClient(baseUrl: string, fetchFn: FetchFn = fetch): AiServerClient {
  async function post<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    accessToken: string,
    schema: S,
    route: 'recipe' | 'check-in',
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
      throw new ApiError('network', timedOut ? 'The AI server took too long to answer.' : `Can't reach the AI server. ${String(e)}`);
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
  };
}

/** Turns a fetch Response into parsed data or an ApiError. Exported for tests. */
export async function parseResponse<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  route: 'recipe' | 'check-in',
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
    throw new ApiError(kindForHttpError(res.status, code, message, route), message, res.status, code);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('bad_response', `Unexpected response from the AI server: ${parsed.error.message}`, res.status);
  }
  return parsed.data;
}
