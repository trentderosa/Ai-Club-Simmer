import { ZodError } from 'zod';
import { getRecipeJsonSchema } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import {
  ensureSafetyFlags,
  type RecipeGenerationResponse,
} from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import { buildCookAnythingPrompt } from './prompt.js';
import { FreeformRecipeSchema } from './recipe-schema.js';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a cook-anything recipe through the same Ollama + Zod path as
 * path slots. Invalid output is retried (3 attempts total) and never saved.
 */
export async function generateCookAnythingRecipe(
  client: OllamaClient,
  dishQuery: string,
  user: UserProfile
): Promise<RecipeGenerationResponse> {
  const prompt = buildCookAnythingPrompt(dishQuery, user);
  const jsonSchema = getRecipeJsonSchema();
  let lastError: Error | ZodError | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2));
    }
    try {
      const responseText = await client.generate(prompt, jsonSchema);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch (parseError) {
        lastError = parseError as Error;
        continue;
      }
      const validationResult = FreeformRecipeSchema.safeParse(parsed);
      if (!validationResult.success) {
        lastError = validationResult.error;
        continue;
      }
      return { success: true, recipe: ensureSafetyFlags(validationResult.data) };
    } catch (error) {
      lastError = error as Error;
    }
  }

  const errorMessage =
    lastError instanceof ZodError
      ? `Schema validation failed: ${lastError.errors.map((e) => e.message).join(', ')}`
      : `Generation failed: ${lastError?.message || 'Unknown error'}`;

  return {
    success: false,
    error: {
      type: lastError instanceof ZodError ? 'validation_failed' : 'generation_failed',
      message: errorMessage,
      attempts: MAX_RETRIES + 1,
    },
  };
}
