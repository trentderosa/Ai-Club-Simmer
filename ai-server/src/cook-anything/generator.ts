import { ZodError } from 'zod';
import { getRecipeJsonSchema, type Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import {
  cleanRecipe,
  ensureSafetyFlags,
  INVALID_JSON_REASON,
  recipeHasAffirmativeProteinRinse,
  type RecipeGenerationResponse,
} from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import { logGenerationFailure } from '../services/generation-failure.js';
import { OllamaBusyError } from '../services/ollama-gate.js';
import { buildCookAnythingPrompt } from './prompt.js';
import { FreeformRecipeSchema } from './recipe-schema.js';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a cook-anything recipe through the same Ollama + Zod path as
 * path slots. Invalid output is retried (3 attempts total). An affirmative
 * raw-protein rinse is rejected the same way; if every attempt still rinses,
 * the flagged recipe is the fallback.
 */
export async function generateCookAnythingRecipe(
  client: OllamaClient,
  dishQuery: string,
  user: UserProfile
): Promise<RecipeGenerationResponse> {
  const prompt = buildCookAnythingPrompt(dishQuery, user);
  const jsonSchema = getRecipeJsonSchema();
  let lastError: Error | ZodError | null = null;
  let lastUnsafeRecipe: Recipe | null = null;

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
      const recipe = ensureSafetyFlags(cleanRecipe(validationResult.data, FreeformRecipeSchema));
      if (recipeHasAffirmativeProteinRinse(recipe)) {
        console.warn('Recipe attempt rejected', { reason: 'unsafe_raw_protein_rinse', attempt });
        lastUnsafeRecipe = recipe;
        lastError = new Error('unsafe_raw_protein_rinse');
        continue;
      }
      return { success: true, recipe };
    } catch (error) {
      // A busy model is not retried: more attempts only deepen the backlog.
      if (error instanceof OllamaBusyError) {
        return {
          success: false,
          error: { type: 'busy', message: 'Model is busy', attempts: attempt },
        };
      }
      lastError = error as Error;
    }
  }

  if (lastUnsafeRecipe) {
    return { success: true, recipe: lastUnsafeRecipe };
  }

  const errorMessage =
    lastError instanceof ZodError
      ? `Schema validation failed: ${lastError.issues.map((e) => e.message).join(', ')}`
      : lastError instanceof SyntaxError
        ? `Generation failed: ${INVALID_JSON_REASON}`
        : `Generation failed: ${lastError?.message || 'Unknown error'}`;

  if (!(lastError instanceof ZodError)) {
    logGenerationFailure(lastError instanceof SyntaxError ? new Error(INVALID_JSON_REASON) : lastError);
  }

  return {
    success: false,
    error: {
      type: lastError instanceof ZodError ? 'validation_failed' : 'generation_failed',
      message: errorMessage,
      attempts: MAX_RETRIES + 1,
    },
  };
}
