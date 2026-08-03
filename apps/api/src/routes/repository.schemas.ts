import { z } from 'zod';

export const importRepositorySchema = z.object({
  githubUrl: z.string().trim().url('Must be a valid URL'),
});

export type ImportRepositoryInput = z.infer<typeof importRepositorySchema>;
