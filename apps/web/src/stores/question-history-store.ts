import { create } from 'zustand';
import type { ArchitectureAnswer } from '../lib/architecture-answer';

interface QuestionHistoryState {
  historyByNodeId: Record<string, ArchitectureAnswer[]>;
  addAnswer: (nodeId: string, answer: ArchitectureAnswer) => void;
  updateAnswer: (nodeId: string, id: string, patch: Partial<ArchitectureAnswer>) => void;
  clearHistory: (nodeId: string) => void;
}

/**
 * Keyed by node ID, deliberately - switching to another node and back
 * preserves that node's own history rather than wiping it, a nicer
 * result than resetting on every click without needing any real
 * persistence system. In-memory only (no persist middleware, unlike
 * the auth store) - this is explicitly local UI state for this task,
 * not something meant to survive a page reload.
 */
export const useQuestionHistoryStore = create<QuestionHistoryState>((set) => ({
  historyByNodeId: {},

  addAnswer: (nodeId, answer) =>
    set((state) => ({
      historyByNodeId: {
        ...state.historyByNodeId,
        [nodeId]: [...(state.historyByNodeId[nodeId] ?? []), answer],
      },
    })),

  updateAnswer: (nodeId, id, patch) =>
    set((state) => ({
      historyByNodeId: {
        ...state.historyByNodeId,
        [nodeId]: (state.historyByNodeId[nodeId] ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)),
      },
    })),

  clearHistory: (nodeId) =>
    set((state) => {
      const { [nodeId]: _removed, ...rest } = state.historyByNodeId;
      return { historyByNodeId: rest };
    }),
}));
