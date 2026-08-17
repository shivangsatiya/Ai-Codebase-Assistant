import { useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { RepositoryList } from './RepositoryList';
import { ImportRepositoryForm } from './ImportRepositoryForm';
import { Button } from '../ui/button';

export function Sidebar() {
  const { email, logout } = useAuthStore();
  const [isImporting, setIsImporting] = useState(false);

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-mono text-sm font-semibold text-fg">Repository Intelligence</span>
      </div>

      <div className="flex flex-col gap-2 border-b border-border p-3">
        <button
          type="button"
          disabled
          className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-fg-subtle opacity-60"
          title="Search is coming in a later task"
        >
          <span>Search…</span>
          <span className="font-mono">⌘K</span>
        </button>

        {isImporting ? (
          <ImportRepositoryForm onDone={() => setIsImporting(false)} />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setIsImporting(true)}>
            Import repository
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        <RepositoryList onImportClick={() => setIsImporting(true)} />
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="truncate font-mono text-xs text-fg-subtle">{email}</span>
        <Button variant="ghost" size="sm" onClick={logout}>
          Sign out
        </Button>
      </div>
    </aside>
  );
}
