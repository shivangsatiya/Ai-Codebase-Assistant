import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listRepositories,
  getRepository,
  importRepository,
  IN_PROGRESS_STATUSES,
  type RepositorySummary,
  type RepositoryDetail,
} from '../lib/repositories-api';
import { ApiError } from '../lib/raw-request';

export const repositoryKeys = {
  list: ['repositories'] as const,
  detail: (id: string) => ['repositories', id] as const,
};

/**
 * Why a dynamic refetchInterval rather than a fixed one, or none at
 * all?
 *
 * A repository stuck showing "queued" until the user manually refreshes
 * is a genuinely poor loading state - the real, live indexing progress
 * (cloning -> parsing -> embedding -> ready) is exactly the kind of
 * thing this interface should surface without asking. Polling
 * unconditionally would mean an indefinite background request every
 * few seconds even once every repository is long since ready or
 * failed - directly wasteful, and a real violation of "fast
 * interactions" as a design principle if left running forever. Only
 * polling while something is genuinely in progress, and stopping the
 * moment nothing is, gets the responsiveness without the waste.
 */
export function useRepositories() {
  return useQuery({
    queryKey: repositoryKeys.list,
    queryFn: listRepositories,
    refetchInterval: (query) => {
      const data = query.state.data as RepositorySummary[] | undefined;
      const hasInProgress = data?.some((repo) => IN_PROGRESS_STATUSES.includes(repo.status));
      return hasInProgress ? 3000 : false;
    },
  });
}

export function useRepository(repositoryId: string | undefined) {
  return useQuery({
    queryKey: repositoryId ? repositoryKeys.detail(repositoryId) : ['repositories', 'none'],
    queryFn: () => getRepository(repositoryId!),
    enabled: Boolean(repositoryId),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 1;
    },
    refetchInterval: (query) => {
      const data = query.state.data as RepositoryDetail | undefined;
      return data && IN_PROGRESS_STATUSES.includes(data.status) ? 3000 : false;
    },
  });
}

export function useImportRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: importRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.list });
    },
  });
}
