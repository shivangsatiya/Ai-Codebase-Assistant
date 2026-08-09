import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { IN_PROGRESS_STATUSES, type RepositorySummary, type RepositoryStatus } from '../../lib/repositories-api';

const STATUS_LABELS: Record<RepositoryStatus, string> = {
  queued: 'Queued',
  cloning: 'Cloning',
  parsing: 'Parsing',
  embedding: 'Embedding',
  ready: 'Ready',
  failed: 'Failed',
};

function StatusDot({ status }: { status: RepositoryStatus }) {
  if (status === 'ready') return <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />;
  if (status === 'failed') return <span className="h-1.5 w-1.5 rounded-full bg-danger" />;
  if (IN_PROGRESS_STATUSES.includes(status)) {
    return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />;
}

interface RepositoryListItemProps {
  repository: RepositorySummary;
  isSelected: boolean;
}

export function RepositoryListItem({ repository, isSelected }: RepositoryListItemProps) {
  const repoName = repository.githubUrl.replace(/^https?:\/\/github\.com\//, '');

  return (
    <Link
      to={`/workspace/${repository.repositoryId}`}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-3 py-2 text-sm transition-colors',
        isSelected
          ? 'border-accent/40 bg-accent-muted/40 text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface-elevated hover:text-fg',
      )}
    >
      <span className="truncate font-mono text-xs">{repoName}</span>
      <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <StatusDot status={repository.status} />
        {STATUS_LABELS[repository.status] ?? repository.status}
        {repository.status === 'ready' && repository.fileCount > 0 && (
          <span>· {repository.fileCount} files</span>
        )}
      </span>
    </Link>
  );
}
