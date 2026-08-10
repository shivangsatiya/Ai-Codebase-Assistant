import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAskQuestion } from '../use-ask-question';
import { isAiGenerated } from '../../lib/architecture-answer';
import { useAuthStore } from '../../stores/auth-store';
import { useQuestionHistoryStore } from '../../stores/question-history-store';

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function mockStreamResponse(chunks: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index++;
          return { done: false, value };
        },
        releaseLock: () => {},
      }),
    },
  };
}

const emptyEdges: never[] = [];
const emptyLabels = new Map<string, string>();

describe('useAskQuestion orchestrator', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
    useQuestionHistoryStore.setState({ historyByNodeId: {} });
  });

  it('UI receives a clean ArchitectureAnswer for a JSON (Pure Graph) response, never the raw RouterAnswer shape', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ category: 'pure_graph', algorithm: 'dependency-analysis', result: { mode: 'direct', nodeIds: [] } }),
      );

    const { result } = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));

    await act(async () => {
      await result.current.ask('what does this depend on?');
    });

    await waitFor(() => expect(result.current.history[0]?.status).toBe('complete'));
    expect(result.current.history[0]?.category).toBe('pure_graph');
    expect(result.current.history[0]?.structuredSummary).toBe('None found.');
  });

  it('UI receives progressively-updating streamed text for a Hybrid/Semantic response, correctly marked as AI-generated', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockStreamResponse(['data: {"token":"Because "}\n\n', 'data: {"token":"of X."}\n\n', 'event: done\ndata: {}\n\n']),
      );

    const { result } = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));

    await act(async () => {
      await result.current.ask('why does this depend on Redis?');
    });

    await waitFor(() => expect(result.current.history[0]?.status).toBe('complete'));
    expect(result.current.history[0]?.streamedText).toBe('Because of X.');
    // REGRESSION: found live in the browser, not by any test - the
    // streaming branch originally never set `category` at all, leaving
    // it undefined for a streamed answer's entire lifecycle. Since
    // isAiGenerated() checks category, this silently mislabeled every
    // AI-generated streamed answer as "Computed directly - no AI
    // involved," exactly the epistemic-honesty violation this whole
    // task exists to prevent. This assertion is what was missing.
    expect(isAiGenerated(result.current.history[0]?.category)).toBe(true);
  });

  it('rejects a duplicate submission while one is already in flight, rather than firing a second request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse(['data: {"token":"slow"}\n\n', 'event: done\ndata: {}\n\n']));
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));

    await act(async () => {
      const first = result.current.ask('question one');
      result.current.ask('question two');
      await first;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.history).toHaveLength(1);
  });

  it('rejects an empty or whitespace-only question without calling fetch at all', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));

    await act(async () => {
      await result.current.ask('   ');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.history).toHaveLength(0);
  });

  it('preserves partial streamed output when the stream is interrupted, rather than discarding it', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockStreamResponse(['data: {"token":"partial answer"}\n\n', 'event: error\ndata: {"message":"Interrupted."}\n\n']),
      );

    const { result } = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));

    await act(async () => {
      await result.current.ask('why?');
    });

    await waitFor(() => expect(result.current.history[0]?.status).toBe('error'));
    expect(result.current.history[0]?.wasInterrupted).toBe(true);
    expect(result.current.history[0]?.streamedText).toBe('partial answer');
  });

  it("keeps separate history per node - switching nodes does not leak one node's questions into another's", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ category: 'pure_graph', algorithm: 'dependency-analysis', result: { mode: 'direct', nodeIds: [] } }),
      );

    const { result, rerender } = renderHook(({ nodeId }) => useAskQuestion('repo-1', nodeId, emptyEdges, emptyLabels), {
      initialProps: { nodeId: 'node-1' },
    });

    await act(async () => {
      await result.current.ask('question for node 1');
    });
    expect(result.current.history).toHaveLength(1);

    rerender({ nodeId: 'node-2' });
    expect(result.current.history).toHaveLength(0);

    rerender({ nodeId: 'node-1' });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.question).toBe('question for node 1');
  });

  it('clearHistory removes only the current node\'s history, leaving other nodes untouched', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse({ category: 'pure_graph', algorithm: 'dependency-analysis', result: { mode: 'direct', nodeIds: [] } }),
      );

    const nodeOne = renderHook(() => useAskQuestion('repo-1', 'node-1', emptyEdges, emptyLabels));
    const nodeTwo = renderHook(() => useAskQuestion('repo-1', 'node-2', emptyEdges, emptyLabels));

    await act(async () => {
      await nodeOne.result.current.ask('question for node 1');
    });
    await act(async () => {
      await nodeTwo.result.current.ask('question for node 2');
    });

    expect(nodeOne.result.current.history).toHaveLength(1);
    expect(nodeTwo.result.current.history).toHaveLength(1);

    act(() => {
      nodeOne.result.current.clearHistory();
    });

    expect(nodeOne.result.current.history).toHaveLength(0);
    expect(nodeTwo.result.current.history).toHaveLength(1);
  });
});
