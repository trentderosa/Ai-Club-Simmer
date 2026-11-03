import { z } from 'zod';

export const CheckInInputSchema = z.object({
  user_recipe_id: z.string().uuid(),
  slot_id: z.number().int().min(1).max(10),
  rating: z.enum(['easy', 'ok', 'hard']),
  went_well: z.string().max(500).optional(),
  was_hard: z.string().max(500).optional(),
});

export type CheckInInput = z.infer<typeof CheckInInputSchema>;

export interface CheckInRecord {
  id: string;
  user_id: string;
  user_recipe_id: string;
  slot_id: number;
  difficulty_rating: 'easy' | 'ok' | 'hard';
  went_well: string | null;
  was_hard: string | null;
  is_repeat: boolean;
  created_at: Date;
}

export const CoachNoteSchema = z.object({
  note: z.string().min(1).max(500),
  focus_area: z.string().optional(),
});

export type CoachNote = z.infer<typeof CoachNoteSchema>;

export interface CheckInResponse {
  check_in_id: string;
  coach_note: string;
  focus_area?: string;
}
