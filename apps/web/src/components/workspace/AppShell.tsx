import { Sidebar } from './Sidebar';
import { WorkspaceCenter } from './WorkspaceCenter';
import { Inspector } from './Inspector';
import { useWorkspaceUiStore } from '../../stores/ui-store';
import { cn } from '../../lib/utils';

export function AppShell() {
  const { isSidebarCollapsed, isInspectorCollapsed, toggleSidebar, toggleInspector } = useWorkspaceUiStore();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg">
      <div className={cn('shrink-0 transition-all', isSidebarCollapsed ? 'w-0 overflow-hidden' : 'w-72')}>
        <Sidebar />
      </div>

      <main className="relative flex-1 overflow-hidden">
        <button
          onClick={toggleSidebar}
          aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute left-2 top-2 z-10 rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          {isSidebarCollapsed ? '›' : '‹'}
        </button>
        <WorkspaceCenter />
        <button
          onClick={toggleInspector}
          aria-label={isInspectorCollapsed ? 'Expand inspector' : 'Collapse inspector'}
          className="absolute right-2 top-2 z-10 rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-fg-muted hover:text-fg"
        >
          {isInspectorCollapsed ? '‹' : '›'}
        </button>
      </main>

      <div className={cn('shrink-0 transition-all', isInspectorCollapsed ? 'w-0 overflow-hidden' : 'w-80')}>
        <Inspector />
      </div>
    </div>
  );
}
