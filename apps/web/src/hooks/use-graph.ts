import { useQuery } from '@tanstack/react-query';
import { getRepositoryGraph, getCycles } from '../lib/graph-api';

export const graphKeys = {
  graph: (repositoryId: string) => ['graph', repositoryId] as const,
  cycles: (repositoryId: string) => ['graph', repositoryId, 'cycles'] as const,
};

export function useRepositoryGraph(repositoryId: string | undefined) {
  return useQuery({
    queryKey: repositoryId ? graphKeys.graph(repositoryId) : ['graph', 'none'],
    queryFn: () => getRepositoryGraph(repositoryId!),
    enabled: Boolean(repositoryId),
  });
}

/**
 * A real, separate query for a real, separate backend endpoint - not
 * bundled into useRepositoryGraph, since cycle detection is its own
 * algorithm with its own cost, fetched only when there's an actual
 * graph to check cycles against (see `enabled` below).
 */
export function useCycles(repositoryId: string | undefined, hasGraph: boolean) {
  return useQuery({
    queryKey: repositoryId ? graphKeys.cycles(repositoryId) : ['graph', 'none', 'cycles'],
    queryFn: () => getCycles(repositoryId!),
    enabled: Boolean(repositoryId) && hasGraph,
    staleTime: Infinity,
  });
}
