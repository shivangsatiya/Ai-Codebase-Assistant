import { useParams } from 'react-router-dom';
import { useRepositories } from '../../hooks/use-repositories';
import { RepositoryListItem } from './RepositoryListItem';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from '../ui/skeleton';

export function RepositoryList({ onImportClick }: { onImportClick: () => void }) {
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const { data: repositories, isLoading, isError, error, refetch } = useRepositories();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-1">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  if (!repositories || repositories.length === 0) {
    return (
      <EmptyState
        title="No repositories yet"
        description="Import a repository to start exploring its architecture."
        action={
          <button onClick={onImportClick} className="text-xs font-medium text-accent hover:underline">
            Import a repository
          </button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-1 px-1">
      {repositories.map((repo) => (
        <RepositoryListItem key={repo.repositoryId} repository={repo} isSelected={repo.repositoryId === repositoryId} />
      ))}
    </div>
  );
}
