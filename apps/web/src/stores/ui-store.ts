import { create } from 'zustand';

type MobilePanel = 'sidebar' | 'main' | 'inspector';

interface WorkspaceUiState {
  isSidebarCollapsed: boolean;
  isInspectorCollapsed: boolean;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  /**
   * Mobile-only navigation state - which single panel is currently
   * shown full-screen. Meaningless on desktop (all three panels render
   * simultaneously there regardless of this value), but kept in the
   * same store rather than a separate one since it's still "how the
   * user has arranged the workspace panels" - the same responsibility
   * this store already owns, just a different layout's version of it.
   */
  mobilePanel: MobilePanel;
  setMobilePanel: (panel: MobilePanel) => void;
}

/**
 * Deliberately holds nothing server-derived - no repository list, no
 * selected repository, no status. The selected repository comes from
 * the URL (React Router's own source of truth, per the design's own
 * instruction not to duplicate what the URL can already provide);
 * repository data itself lives exclusively in TanStack Query's cache.
 * This store's only job is remembering how the user has arranged the
 * workspace panels.
 */
export const useWorkspaceUiStore = create<WorkspaceUiState>((set) => ({
  isSidebarCollapsed: false,
  isInspectorCollapsed: false,
  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
  toggleInspector: () => set((state) => ({ isInspectorCollapsed: !state.isInspectorCollapsed })),
  mobilePanel: 'sidebar',
  setMobilePanel: (panel) => set({ mobilePanel: panel }),
}));
