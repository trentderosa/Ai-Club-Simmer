import { ZodError } from 'zod';
import { getRecipeJsonSchema, type Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import {
  dropUnsafeCoachNote,
  cleanRecipe,
  ensureSafetyFlags,
  INVALID_JSON_REASON,
  recipeHasAffirmativeProteinRinse,
  type RecipeGenerationResponse,
} from '../services/recipe-generator.js';
import type { OllamaClient } from '../services/ollama-client.js';
import { logGenerationFailure } from '../services/generation-failure.js';
import { OllamaBusyError } from '../services/ollama-gate.js';
import { parseDietRules, findDietViolations, dietCorrectiveHint } from '../services/diet-guard.js';
import { ensureDonenessSteps } from '../services/doneness.js';
import { startDeadline, type OllamaBudget } from '../services/ollama-budget.js';
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
  user: UserProfile,
  options: { budget?: OllamaBudget } = {}
): Promise<RecipeGenerationResponse> {
  const prompt = buildCookAnythingPrompt(dishQuery, user);
  const jsonSchema = getRecipeJsonSchema();
  const dietRules = parseDietRules(user.dietaryNeeds);
  let retryHint = '';
  let lastError: Error | ZodError | null = null;
  let lastUnsafeRecipe: Recipe | null = null;
  // Caps queue time plus Ollama time for the whole request, retries included.
  const deadline = options.budget ? startDeadline(options.budget) : null;
  let attemptsMade = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) {
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2));
    }
    let queueTimeoutMs: number | undefined;
    if (deadline) {
      queueTimeoutMs = deadline.nextQueueTimeoutMs();
      if (queueTimeoutMs <= 0) {
        // The budget cannot cover another attempt. Keep the earlier failure.
        console.warn('recipe_generation_budget_exhausted', { attempt });
        if (!lastError) {
          return {
            success: false,
            error: { type: 'busy', message: 'Model is busy', attempts: 0 },
          };
        }
        attemptsMade = attempt - 1;
        break;
      }
    }
    try {
      const attemptPrompt = retryHint ? `${prompt}\n\n${retryHint}` : prompt;
      retryHint = '';
      const responseText =
        queueTimeoutMs === undefined
          ? await client.generate(attemptPrompt, jsonSchema)
          : await client.generate(attemptPrompt, jsonSchema, { queueTimeoutMs });
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
      const cleaned = dropUnsafeCoachNote(cleanRecipe(validationResult.data, FreeformRecipeSchema));
      // Same dietary check as path recipes: a violation is a failed attempt and never a fallback.
      const dietViolations = findDietViolations(cleaned, dietRules);
      if (dietViolations.length > 0) {
        console.warn('Recipe attempt rejected', {
          reason: 'diet_violation',
          attempt,
          violations: dietViolations.map((v) => ({ rule: v.rule, term: v.term, where: v.where })),
        });
        retryHint = dietCorrectiveHint(dietViolations);
        lastError = new Error('diet_violation');
        continue;
      }
      const withDoneness = ensureDonenessSteps(cleaned);
      const recipe = ensureSafetyFlags(
        FreeformRecipeSchema.safeParse(withDoneness).success ? withDoneness : cleaned
      );
      if (recipeHasAffirmativeProteinRinse(recipe)) {
        console.warn('Recipe attempt rejected', { reason: 'unsafe_raw_protein_rinse', attempt });
        lastUnsafeRecipe = recipe;
        lastError = new Error('unsafe_raw_protein_rinse');
        continue;
      }
      return { success: true, recipe };
    } catch (error) {
      // A busy model is not retried: more attempts only deepen the backlog.
      // Intentional fail-safe: this also discards an earlier flagged rinse
      // fallback (lastUnsafeRecipe). A busy answer is never turned into a
      // recipe that may tell the cook to rinse raw meat.
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
      attempts: attemptsMade,
    },
  };
}
