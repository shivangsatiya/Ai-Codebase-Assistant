import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IN_PROGRESS_STATUSES, type RepositorySummary, type RepositoryStatus } from '../../lib/repositories-api';
import { useDeleteRepository } from '../../hooks/use-repositories';
import { Button } from '../ui/button';

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
  const navigate = useNavigate();
  const deleteRepository = useDeleteRepository();
  const [confirming, setConfirming] = useState(false);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-reverts the armed "confirm delete?" state after a few seconds
  // if the person clicks away or just changes their mind without
  // clicking anywhere else - a real, deliberate choice over requiring
  // an explicit "cancel" click for something this reversible to back
  // out of.
  useEffect(() => {
    if (!confirming) return;
    confirmTimeoutRef.current = setTimeout(() => setConfirming(false), 4000);
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, [confirming]);

  function handleDeleteClick(e: React.MouseEvent) {
    // Both required - this button lives inside the row's own <Link>,
    // so without stopping propagation a click here would also navigate
    // to the repository it's trying to delete.
    e.preventDefault();
    e.stopPropagation();

    if (!confirming) {
      setConfirming(true);
      return;
    }

    deleteRepository.mutate(repository.repositoryId, {
      onSuccess: () => {
        if (isSelected) {
          // The workspace route this row's own Link points to no
          // longer has anything to show - navigate to the base
          // workspace route rather than leave the person looking at a
          // 404 for a repository they just deleted themselves.
          navigate('/workspace');
        }
      },
    });
  }

  function handleCancelClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
  }

  return (
    <Link
      to={`/workspace/${repository.repositoryId}`}
      data-testid="repository-list-item"
      className={cn(
        'group flex flex-col gap-1 rounded-md border px-3 py-2 text-sm transition-colors',
        isSelected
          ? 'border-accent/40 bg-accent-muted/40 text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface-elevated hover:text-fg',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs">{repoName}</span>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="danger"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={handleDeleteClick}
              disabled={deleteRepository.isPending}
              data-testid="confirm-delete-repository"
            >
              {deleteRepository.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <button
              type="button"
              onClick={handleCancelClick}
              disabled={deleteRepository.isPending}
              aria-label="Cancel delete"
              className="rounded p-1 text-fg-subtle hover:bg-surface-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleDeleteClick}
            aria-label={`Delete ${repoName}`}
            data-testid="delete-repository-button"
            className="shrink-0 rounded p-1 text-fg-subtle opacity-0 hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <StatusDot status={repository.status} />
        {STATUS_LABELS[repository.status] ?? repository.status}
        {repository.status === 'ready' && repository.fileCount > 0 && (
          <span>· {repository.fileCount} files</span>
        )}
      </span>
      {deleteRepository.isError && (
        <span className="text-xs text-danger">Couldn't delete - {deleteRepository.error.message}</span>
      )}
    </Link>
  );
}
