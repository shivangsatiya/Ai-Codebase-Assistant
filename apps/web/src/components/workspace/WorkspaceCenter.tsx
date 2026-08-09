import { useParams } from 'react-router-dom';
import { useRepository } from '../../hooks/use-repositories';
import { ApiError } from '../../lib/raw-request';
import { Skeleton } from '../ui/skeleton';
import { IN_PROGRESS_STATUSES } from '../../lib/repositories-api';

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

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-fg-subtle">The Repository Knowledge Graph for this repository will appear here.</p>
    </div>
  );
}
