import { apiRequest } from './api-client';

export type RepositoryStatus = 'queued' | 'cloning' | 'parsing' | 'embedding' | 'ready' | 'failed';

/**
 * Matches GET /api/repositories exactly, verified directly against
 * repository.routes.ts before writing this - no `owner` field exists on
 * the real response, so none is declared here. Inventing one (even as
 * optional) would invite a component to reference a value that will
 * always be undefined in practice.
 */
export interface RepositorySummary {
  repositoryId: string;
  githubUrl: string;
  status: RepositoryStatus;
  isPrivate: boolean;
  fileCount: number;
}

export interface RepositoryJob {
  stage: string;
  progress: number;
  error: string | null;
}

/** Matches GET /api/repositories/:id exactly. */
export interface RepositoryDetail {
  repositoryId: string;
  githubUrl: string;
  status: RepositoryStatus;
  fileCount: number;
  errorMessage: string | null;
  job: RepositoryJob | null;
}

/** Matches the 202 response from POST /api/repositories - status here is 'queued', never 'ready'. */
export interface ImportRepositoryResult {
  repositoryId: string;
  status: RepositoryStatus;
  jobId: string;
}

export const IN_PROGRESS_STATUSES: RepositoryStatus[] = ['queued', 'cloning', 'parsing', 'embedding'];

export async function listRepositories(): Promise<RepositorySummary[]> {
  const result = await apiRequest<{ repositories: RepositorySummary[] }>('/api/repositories');
  return result.repositories;
}

export async function getRepository(repositoryId: string): Promise<RepositoryDetail> {
  return apiRequest<RepositoryDetail>(`/api/repositories/${repositoryId}`);
}

export async function importRepository(githubUrl: string): Promise<ImportRepositoryResult> {
  return apiRequest<ImportRepositoryResult>('/api/repositories', {
    method: 'POST',
    body: JSON.stringify({ githubUrl }),
  });
}
