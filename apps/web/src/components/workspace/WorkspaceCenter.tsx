import { useParams } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { useRepository } from '../../hooks/use-repositories';
import { ApiError } from '../../lib/raw-request';
import { Skeleton } from '../ui/skeleton';
import { IN_PROGRESS_STATUSES } from '../../lib/repositories-api';

/**
 * Lazy-loaded deliberately, not by default: a real build-time warning
 * flagged the production bundle at ~600KB gzipped after adding React
 * Flow + ELK.js, up from ~100KB - weight that a user on the login page
 * or browsing their repository list never needs to download at all.
 * Split into its own chunk, fetched only once someone actually opens a
 * repository with a graph to show.
 */
const RepositoryGraph = lazy(() =>
  import('../graph/RepositoryGraph').then((m) => ({ default: m.RepositoryGraph })),
);

export function WorkspaceCenter() {
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const { data: repository, isLoading, isError, error } = useRepository(repositoryId);

  if (!repositoryId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-subtle">Select a repository from the sidebar to get started.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton className="h-64 w-96" />
      </div>
    );
  }

  if (isError) {
    const message =
      error instanceof ApiError && error.status === 404 ? 'Repository not found.' : 'Could not load this repository.';
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-subtle">{message}</p>
      </div>
    );
  }

  if (repository && IN_PROGRESS_STATUSES.includes(repository.status)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-fg">Indexing in progress…</p>
        <p className="font-mono text-xs text-fg-subtle">{repository.job?.stage ?? repository.status}</p>
      </div>
    );
  }

  if (repository?.status === 'failed') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-danger">{repository.errorMessage ?? 'This import failed.'}</p>
      </div>
    );
  }

  const repoName = repository?.githubUrl.replace(/^https?:\/\/github\.com\//, '') ?? '';

  return (
    <div className="flex h-full flex-col">
      {/* Explicit repository identity above the graph itself - the
          sidebar already highlights the selected repository, but a
          full-bleed graph with no other visible chrome shouldn't rely
          on the user having to look elsewhere to confirm what they're
          looking at. */}
      <div className="border-b border-border px-4 py-2">
        <p className="truncate font-mono text-xs text-fg-muted">{repoName}</p>
      </div>
      <div className="flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Skeleton className="h-8 w-64" />
            </div>
          }
        >
          <RepositoryGraph repositoryId={repositoryId} />
        </Suspense>
      </div>
    </div>
  );
}
