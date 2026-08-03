import { z } from 'zod';

export const askQuestionSchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000, 'Message is too long'),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
