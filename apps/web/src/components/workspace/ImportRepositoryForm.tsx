import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useImportRepository } from '../../hooks/use-repositories';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ApiError } from '../../lib/raw-request';

interface ImportRepositoryFormProps {
  onDone: () => void;
}

function isLikelyGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === 'github.com' || url.hostname === 'www.github.com';
  } catch {
    return false;
  }
}

export function ImportRepositoryForm({ onDone }: ImportRepositoryFormProps) {
  const navigate = useNavigate();
  const [githubUrl, setGithubUrl] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const { mutate, isPending, error, reset } = useImportRepository();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);
    reset();

    if (!isLikelyGithubUrl(githubUrl)) {
      setValidationError('Enter a valid github.com repository URL.');
      return;
    }

    mutate(githubUrl, {
      onSuccess: (result) => {
        // 'accepted', never 'ready' - the real status this endpoint
        // returns is always 'queued' at this point; the repository
        // list's own status indicator (and its polling) is what tells
        // the user when it's actually done, not this form.
        navigate(`/workspace/${result.repositoryId}`);
        onDone();
      },
    });
  }

  const displayError =
    validationError ?? (error instanceof ApiError ? error.message : error ? 'Import failed. Please try again.' : null);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-md border border-border bg-surface-elevated p-3">
      <label htmlFor="import-github-url" className="sr-only">
        GitHub repository URL
      </label>
      <Input
        id="import-github-url"
        placeholder="https://github.com/owner/repo"
        value={githubUrl}
        onChange={(e) => setGithubUrl(e.target.value)}
        disabled={isPending}
        autoFocus
      />
      {displayError && <p className="text-xs text-danger">{displayError}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending || githubUrl.trim().length === 0} className="flex-1">
          {isPending ? 'Importing…' : 'Import'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
