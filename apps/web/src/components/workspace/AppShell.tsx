import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { WorkspaceCenter } from './WorkspaceCenter';
import { Inspector } from './Inspector';
import { useWorkspaceUiStore } from '../../stores/ui-store';
import { useGraphUiStore } from '../../stores/graph-ui-store';
import { useIsMobileLayout } from '../../hooks/use-media-query';
import { cn } from '../../lib/utils';

export function AppShell() {
  const { isSidebarCollapsed, isInspectorCollapsed, toggleSidebar, toggleInspector, mobilePanel, setMobilePanel } =
    useWorkspaceUiStore();
  const isMobile = useIsMobileLayout();
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const navigate = useNavigate();
  const selectedNodeId = useGraphUiStore((s) => s.selectedNodeId);

  // Mobile-only auto-advance: a selected repository or node is real,
  // meaningful intent to move forward a panel - deliberately watching
  // the same real state (the URL's repositoryId, the graph store's
  // selectedNodeId) that desktop already treats as the source of
  // truth, rather than inventing separate "which panel" state that
  // could drift out of sync with what's actually selected. This is
  // also exactly why going "back" on mobile (below, in Sidebar/
  // Inspector) navigates the URL or deselects the node, rather than
  // just setting mobilePanel directly - if it didn't, this same effect
  // would immediately fight that action and snap forward again.
  useEffect(() => {
    if (!isMobile) return;
    setMobilePanel(repositoryId ? 'main' : 'sidebar');
  }, [isMobile, repositoryId, setMobilePanel]);

  useEffect(() => {
    if (!isMobile) return;
    if (selectedNodeId) {
      setMobilePanel('inspector');
    } else if (mobilePanel === 'inspector') {
      setMobilePanel('main');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, selectedNodeId]);

  if (isMobile) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
        {mobilePanel === 'sidebar' && <Sidebar />}
        {mobilePanel === 'main' && (
          <>
            <button
              type="button"
              onClick={() => navigate('/workspace')}
              className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-4 py-2.5 text-sm text-fg-muted active:bg-surface-elevated"
            >
              <span aria-hidden="true">‹</span> Repositories
            </button>
            <div className="min-h-0 flex-1">
              <WorkspaceCenter />
            </div>
          </>
        )}
        {mobilePanel === 'inspector' && <Inspector />}
      </div>
    );
  }

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
