import { z } from 'zod';

/**
 * Recipe Schema - Matches PRD F3 acceptance criteria:
 *
 * "The recipe has: title, ingredients (with amounts), time estimate, ordered steps,
 * and for each step: instruction text, an optional 'why it matters' note,
 * a is_safety_step flag, and an optional technique name for video lookup."
 *
 * This schema is used for:
 * 1. Zod validation of LLM output (RecipeSchema)
 * 2. JSON Schema for Ollama structured output (getRecipeJsonSchema)
 *
 * Both must stay in sync. The Zod schema is the source of truth for TypeScript types.
 */

export const RecipeStepSchema = z.object({
  instruction: z.string().min(1).describe('The step instruction text'),
  whyItMatters: z
    .string()
    .optional()
    .describe('Optional explanation of why this step matters'),
  isSafetyStep: z
    .boolean()
    .describe(
      'True if this step involves heat, knives, boiling water, raw meat, or hot oil'
    ),
  techniqueName: z
    .string()
    .optional()
    .describe('Optional technique name for video lookup (e.g., "dice onion")'),
});

export const IngredientSchema = z.object({
  name: z.string().min(1).describe('Ingredient name'),
  amount: z.string().min(1).describe('Amount with unit (e.g., "2 cups", "1 lb")'),
});

export const RecipeSchema = z.object({
  title: z.string().min(1).describe('Recipe title'),
  ingredients: z
    .array(IngredientSchema)
    .min(1)
    .describe('List of ingredients with amounts'),
  timeEstimateMinutes: z
    .number()
    .int()
    .positive()
    .describe('Estimated cooking time in minutes'),
  steps: z.array(RecipeStepSchema).min(1).describe('Ordered list of cooking steps'),
  coachNote: z
    .string()
    .optional()
    .describe('Optional personalized tip based on user feedback'),
});

export type RecipeStep = z.infer<typeof RecipeStepSchema>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * Returns a JSON Schema object for Ollama's structured output feature.
 *
 * Ollama uses this schema to constrain the LLM's output format. The schema
 * must match our Zod schema above. We define it manually (not auto-generated)
 * because Ollama's JSON schema support has specific requirements.
 *
 * Note: Even with a JSON schema, LLMs can produce invalid output, so we
 * always validate with Zod after parsing. The JSON schema just improves
 * the success rate on the first attempt.
 */
export function getRecipeJsonSchema(): object {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Recipe title' },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Ingredient name' },
            amount: {
              type: 'string',
              description: 'Amount with unit (e.g., "2 cups", "1 lb")',
            },
          },
          required: ['name', 'amount'],
        },
        description: 'List of ingredients with amounts',
      },
      timeEstimateMinutes: {
        type: 'integer',
        description: 'Estimated cooking time in minutes',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'The step instruction text' },
            whyItMatters: {
              type: 'string',
              description: 'Optional explanation of why this step matters',
            },
            isSafetyStep: {
              type: 'boolean',
              description:
                'True if this step involves heat, knives, boiling water, raw meat, or hot oil',
            },
            techniqueName: {
              type: 'string',
              description:
                'Optional technique name for video lookup (e.g., "dice onion")',
            },
          },
          required: ['instruction', 'isSafetyStep'],
        },
        description: 'Ordered list of cooking steps',
      },
      coachNote: {
        type: 'string',
        description: 'Optional personalized tip based on user feedback',
      },
    },
    required: ['title', 'ingredients', 'timeEstimateMinutes', 'steps'],
  };
}
