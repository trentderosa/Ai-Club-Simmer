import { z } from 'zod';

export const ExperienceLevelSchema = z.enum([
  'never_cooked',
  'a_little',
  'comfortable',
]);

export const BudgetLevelSchema = z.enum(['low', 'medium', 'high']);

// Dietary needs are optional since they're not yet in PRD onboarding (F1),
// but the AI server accepts them for future compatibility and testing.
export const DietaryNeedsSchema = z.array(z.string().min(1).max(100)).max(20);

export const CheckInSchema = z.object({
  recipeName: z.string().min(1).max(200),
  difficulty: z.enum(['easy', 'ok', 'hard']),
  whatWentWell: z.string().max(1000).optional(),
  whatWasHard: z.string().max(1000).optional(),
});

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  experienceLevel: ExperienceLevelSchema,
  budget: BudgetLevelSchema,
  equipment: z
    .array(z.string().min(1).max(100))
    .max(50)
    .describe('List of equipment the user has'),
  dietaryNeeds: DietaryNeedsSchema.optional().describe(
    'Optional dietary restrictions/preferences (e.g., vegetarian, gluten-free)'
  ),
  recentCheckIns: z
    .array(CheckInSchema)
    .max(10)
    .optional()
    .describe('Recent cooking feedback for personalization'),
});

export type ExperienceLevel = z.infer<typeof ExperienceLevelSchema>;
export type BudgetLevel = z.infer<typeof BudgetLevelSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
