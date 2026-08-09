import { create } from 'zustand';

interface GraphUiState {
  selectedNodeId: string | null;
  selectNode: (id: string | null) => void;
}

/**
 * Deliberately stores only the ID, never the node object itself -
 * the actual node data lives in TanStack Query's already-fetched graph
 * cache. Storing a second copy here would mean two sources of truth for
 * the same data, with no way to keep them in sync if the graph ever
 * refetches.
 */
export const useGraphUiStore = create<GraphUiState>((set) => ({
  selectedNodeId: null,
  selectNode: (id) => set({ selectedNodeId: id }),
}));
