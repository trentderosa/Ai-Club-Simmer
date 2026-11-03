import { ZodError } from 'zod';
import { Recipe, RecipeSchema, getRecipeJsonSchema } from '../schemas/recipe.js';
import { UserProfile } from '../schemas/user.js';
import type { OllamaClient } from './ollama-client.js';

export interface RecipeGenerationResult {
  success: true;
  recipe: Recipe;
}

export interface RecipeGenerationError {
  success: false;
  error: {
    type: 'validation_failed' | 'generation_failed';
    message: string;
    attempts: number;
  };
}

export type RecipeGenerationResponse = RecipeGenerationResult | RecipeGenerationError;

export interface PathSlot {
  id: number;
  dishName: string;
  techniqueFocus: string;
}

// Maximum retry attempts after the initial try. Total attempts = MAX_RETRIES + 1 = 3.
// This matches PRD F3: "Invalid output is retried up to 2 times"
const MAX_RETRIES = 2;

// Keywords used to detect safety-critical steps. These map to PRD F3 requirement:
// "Steps involving heat, knives, boiling water, raw meat, or hot oil are flagged as safety steps."
// We cast a wide net with related terms to catch variations in LLM output.
const SAFETY_KEYWORDS = [
  'heat',
  'hot',
  'boil',
  'boiling',
  'knife',
  'knives',
  'cut',
  'chop',
  'dice',
  'slice',
  'raw meat',
  'raw chicken',
  'raw beef',
  'raw pork',
  'raw fish',
  'hot oil',
  'fry',
  'frying',
  'sear',
  'searing',
  'oven',
  'stove',
  'burner',
  'flame',
  'steam',
];

/**
 * Builds the prompt sent to Ollama for recipe generation.
 *
 * The prompt structure:
 * 1. System context: Identifies this as a Simmer cooking app recipe request
 * 2. Target dish: What recipe to generate (from the path slot)
 * 3. User profile: Only fields relevant to recipe generation are included:
 *    - Experience level → affects instruction detail and complexity
 *    - Budget → affects ingredient choices
 *    - Equipment → hard constraint on what steps are allowed
 *    - Dietary needs (optional) → hard constraint on ingredients
 *    - Recent check-ins (optional) → enables personalized coach notes
 * 4. Critical constraints: Explicit rules the model must follow
 * 5. Output requirements: What fields to include in the response
 *
 * We only include user fields that affect recipe generation to minimize
 * prompt size and avoid leaking unnecessary user data to the model.
 */
function buildPrompt(slot: PathSlot, user: UserProfile): string {
  const equipmentList = user.equipment.join(', ') || 'basic kitchen items only';

  const experienceDescriptions: Record<typeof user.experienceLevel, string> = {
    never_cooked: 'a complete beginner who has never cooked before',
    a_little: 'someone with a little cooking experience',
    comfortable: 'someone comfortable with basic cooking',
  };

  const budgetDescriptions: Record<typeof user.budget, string> = {
    low: 'a low budget (use affordable, common ingredients)',
    medium: 'a medium budget',
    high: 'a flexible budget',
  };

  // Dietary needs are optional (not yet in PRD onboarding F1).
  // When present, they become hard constraints on ingredients.
  let dietarySection = '';
  if (user.dietaryNeeds && user.dietaryNeeds.length > 0) {
    dietarySection = `- Dietary needs: ${user.dietaryNeeds.join(', ')}\n`;
  }

  // Recent check-ins enable personalized "coach notes" per PRD F6:
  // "the recipe includes a short 'Coach's note' at the top that references them"
  let coachContext = '';
  if (user.recentCheckIns && user.recentCheckIns.length > 0) {
    const recentFeedback = user.recentCheckIns
      .slice(-3)
      .map((c) => {
        let feedback = `- ${c.recipeName}: rated ${c.difficulty}`;
        if (c.whatWentWell) feedback += `, went well: "${c.whatWentWell}"`;
        if (c.whatWasHard) feedback += `, was hard: "${c.whatWasHard}"`;
        return feedback;
      })
      .join('\n');
    coachContext = `

Recent cooking feedback from this user:
${recentFeedback}

Based on this feedback, include a short "coachNote" at the top of the recipe that references what they found challenging or successful.`;
  }

  // Dietary constraint instructions only added when user has dietary needs
  const dietaryConstraint =
    user.dietaryNeeds && user.dietaryNeeds.length > 0
      ? `\n7. RESPECT dietary needs: Do NOT include any ingredients that violate the user's dietary restrictions.`
      : '';

  return `You are a helpful cooking instructor creating a recipe for the Simmer cooking app.

Create a recipe for: ${slot.dishName}
Technique focus: ${slot.techniqueFocus}

User profile:
- Experience: ${experienceDescriptions[user.experienceLevel]}
- Budget: ${budgetDescriptions[user.budget]}
- Available equipment: ${equipmentList}
${dietarySection}
CRITICAL CONSTRAINTS:
1. ONLY use equipment from the user's available equipment list. Do NOT include any steps that require equipment they don't have.
2. Adapt the recipe complexity to match their experience level.
3. Keep ingredient costs appropriate for their budget.
4. Flag any step involving heat, knives, boiling water, raw meat, or hot oil as a safety step (isSafetyStep: true).
5. Include "whyItMatters" explanations for key technique steps to help them learn.
6. Include "techniqueName" for steps that could benefit from a video demonstration.${dietaryConstraint}
${coachContext}

Generate a complete recipe with:
- A clear title
- A list of ingredients with amounts
- Time estimate in minutes
- Ordered steps with instructions, safety flags, and optional technique names/explanations`;
}

/**
 * Post-processes a validated recipe to ensure all safety steps are flagged.
 *
 * Even though we ask the LLM to flag safety steps, small models sometimes miss them.
 * This function scans each step's instruction for safety keywords and sets
 * isSafetyStep=true if any are found. Existing true flags are preserved.
 *
 * This ensures we never return a recipe with unflagged dangerous steps.
 */
function ensureSafetyFlags(recipe: Recipe): Recipe {
  return {
    ...recipe,
    steps: recipe.steps.map((step) => {
      const instructionLower = step.instruction.toLowerCase();
      const hasSafetyKeyword = SAFETY_KEYWORDS.some((keyword) =>
        instructionLower.includes(keyword)
      );

      return {
        ...step,
        isSafetyStep: step.isSafetyStep || hasSafetyKeyword,
      };
    }),
  };
}

/**
 * Generates a recipe using the Ollama LLM with retry logic.
 *
 * Retry loop explanation:
 * - We attempt generation up to MAX_RETRIES + 1 times (3 total per PRD F3).
 * - Each attempt calls Ollama with a JSON schema for structured output.
 * - The response is parsed as JSON and validated against our Zod schema.
 * - If parsing or validation fails, we retry with the same prompt.
 * - If an Ollama error occurs (network, model error), we also retry.
 *
 * Important: We never return a "half-valid" recipe. Either the recipe passes
 * full Zod validation and safety post-processing, or we return an error.
 * There is no partial success state.
 *
 * On success: Returns { success: true, recipe: Recipe }
 * On failure: Returns { success: false, error: { type, message, attempts } }
 */
export async function generateRecipe(
  client: OllamaClient,
  slot: PathSlot,
  user: UserProfile
): Promise<RecipeGenerationResponse> {
  const prompt = buildPrompt(slot, user);
  const jsonSchema = getRecipeJsonSchema();

  let lastError: Error | ZodError | null = null;

  // Retry loop: attempt up to MAX_RETRIES + 1 times (initial + 2 retries = 3 total)
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      // Call Ollama with structured JSON output format
      const responseText = await client.generate(prompt, jsonSchema);

      // Step 1: Parse as JSON. LLMs sometimes output malformed JSON despite schema.
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch (parseError) {
        lastError = parseError as Error;
        continue; // Retry on JSON parse failure
      }

      // Step 2: Validate against our strict Zod schema.
      // This catches missing required fields, wrong types, empty arrays, etc.
      const validationResult = RecipeSchema.safeParse(parsed);
      if (!validationResult.success) {
        lastError = validationResult.error;
        continue; // Retry on schema validation failure
      }

      // Step 3: Post-process to ensure safety flags are set.
      // Only reached if schema validation passed - never returns half-valid data.
      const recipeWithSafetyFlags = ensureSafetyFlags(validationResult.data);

      return {
        success: true,
        recipe: recipeWithSafetyFlags,
      };
    } catch (error) {
      // Ollama client error (network, model not found, etc.)
      lastError = error as Error;
      // Continue to retry
    }
  }

  // All attempts exhausted - return typed error with context
  const errorMessage =
    lastError instanceof ZodError
      ? `Schema validation failed: ${lastError.errors.map((e) => e.message).join(', ')}`
      : `Generation failed: ${lastError?.message || 'Unknown error'}`;

  return {
    success: false,
    error: {
      type:
        lastError instanceof ZodError ? 'validation_failed' : 'generation_failed',
      message: errorMessage,
      attempts: MAX_RETRIES + 1,
    },
  };
}

export { buildPrompt, ensureSafetyFlags, SAFETY_KEYWORDS };
