import { useParams } from 'react-router-dom';
import { useRepository } from '../../hooks/use-repositories';
import { Skeleton } from '../ui/skeleton';

export function Inspector() {
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const { data: repository, isLoading, isError } = useRepository(repositoryId);

  if (!repositoryId) {
    return (
      <aside className="flex h-full w-80 flex-col border-l border-border bg-surface p-4">
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-2 text-xs text-fg-subtle">Select a repository to see its structure and metrics here.</p>
      </aside>
    );
  }

  if (isLoading) {
    return (
      <aside className="flex h-full w-80 flex-col gap-3 border-l border-border bg-surface p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </aside>
    );
  }

  if (isError || !repository) {
    return (
      <aside className="flex h-full w-80 flex-col border-l border-border bg-surface p-4">
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-2 text-xs text-fg-subtle">Could not load this repository.</p>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-80 flex-col gap-3 border-l border-border bg-surface p-4">
      <div>
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-1 truncate font-mono text-xs text-fg-subtle">{repository.githubUrl}</p>
      </div>

      <div className="flex flex-col gap-1 text-xs text-fg-muted">
        <div className="flex justify-between">
          <span>Status</span>
          <span className="text-fg">{repository.status}</span>
        </div>
        {repository.status === 'ready' && (
          <div className="flex justify-between">
            <span>Files</span>
            <span className="text-fg">{repository.fileCount}</span>
          </div>
        )}
      </div>

      <p className="mt-auto text-xs text-fg-subtle">
        Full architecture metrics and node inspection will appear here once the knowledge graph view is built.
      </p>
    </aside>
  );
}