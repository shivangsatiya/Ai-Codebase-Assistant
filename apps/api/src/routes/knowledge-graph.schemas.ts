import { z } from 'zod';

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1, 'question is required'),
  nodeId: z.string().trim().min(1).optional(),
  targetNodeId: z.string().trim().min(1).optional(),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
