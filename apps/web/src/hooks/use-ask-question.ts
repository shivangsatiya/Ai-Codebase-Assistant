import { useCallback, useEffect, useRef, useState } from 'react';
import { askQuestion as callAskApi } from '../lib/ask-api';
import { ApiError } from '../lib/raw-request';
import { formatStructuredResult, isAiGenerated, type ArchitectureAnswer } from '../lib/architecture-answer';
import { computeNodeRelationships } from '../lib/graph-relationships';
import { useQuestionHistoryStore } from '../stores/question-history-store';
import type { FlowEdge } from '../lib/graph-adapter';

// A single, stable reference reused for every node with no history yet
// - a real bug found by actually running the tests, not assumed
// correct: returning a fresh `[]` literal from a Zustand selector on
// every call defeats the store's reference-equality snapshot check,
// since React sees "the store changed" on every single render and
// loops forever trying to re-render in response.
const EMPTY_HISTORY: ArchitectureAnswer[] = [];

export function useAskQuestion(
  repositoryId: string,
  nodeId: string,
  edges: FlowEdge[],
  labelById: Map<string, string>,
) {
  const history = useQuestionHistoryStore((s) => s.historyByNodeId[nodeId] ?? EMPTY_HISTORY);
  const addAnswer = useQuestionHistoryStore((s) => s.addAnswer);
  const updateAnswer = useQuestionHistoryStore((s) => s.updateAnswer);
  const clearHistoryInStore = useQuestionHistoryStore((s) => s.clearHistory);
  const [isAsking, setIsAsking] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // A real race, found by running the tests, not assumed handled: two
  // synchronous calls to ask() in the same tick both read the same
  // isAsking=false, since React state updates are batched and the
  // second call's closure captures state from before the first call's
  // setIsAsking(true) has actually committed. A ref updates
  // synchronously and closes that window; isAsking (state) still
  // drives what the UI renders.
  const isAskingRef = useRef(false);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || isAskingRef.current) return;

      isAskingRef.current = true;
      const id = crypto.randomUUID();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsAsking(true);

      addAnswer(nodeId, { id, question: trimmed, nodeId, status: 'loading' });

      try {
        const result = await callAskApi(repositoryId, { question: trimmed, nodeId }, controller.signal);

        if (result.mode === 'json') {
          updateAnswer(nodeId, id, {
            status: 'complete',
            category: result.answer.category,
            structuredSummary: formatStructuredResult(result.answer, labelById),
          });
          return;
        }

        // Reaching this branch at all means the backend classified the
        // question as hybrid or pure_semantic - JSON mode is the only
        // other outcome, and that's already handled above. A real,
        // serious bug lived here until caught live in the browser: this
        // branch never set `category` at all, leaving it undefined for
        // a streamed answer's entire lifecycle - since isAiGenerated()
        // checks category, every AI-generated streamed answer was
        // silently mislabeled "Computed directly - no AI involved,"
        // exactly the epistemic-honesty violation this whole task
        // exists to prevent. The specific value doesn't need to
        // distinguish hybrid from pure_semantic here - isAiGenerated()
        // treats both identically - it only needs to be one of the two
        // AI categories, which reaching this branch already guarantees.
        const relationships = computeNodeRelationships(nodeId, edges);
        updateAnswer(nodeId, id, {
          status: 'streaming',
          category: 'hybrid',
          streamedText: '',
          graphFacts: { incomingCount: relationships.incomingCount, outgoingCount: relationships.outgoingCount },
        });

        let accumulated = '';
        for await (const event of result.events) {
          if (event.type === 'token') {
            accumulated += event.text;
            updateAnswer(nodeId, id, { streamedText: accumulated });
          } else if (event.type === 'done') {
            updateAnswer(nodeId, id, { status: 'complete' });
          } else if (event.type === 'error') {
            updateAnswer(nodeId, id, { status: 'error', wasInterrupted: true, errorMessage: event.message });
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          updateAnswer(nodeId, id, { status: 'error', wasInterrupted: true, errorMessage: 'Cancelled.' });
        } else if (err instanceof ApiError) {
          updateAnswer(nodeId, id, { status: 'error', errorMessage: err.message });
        } else {
          updateAnswer(nodeId, id, { status: 'error', errorMessage: 'Something went wrong. Please try again.' });
        }
      } finally {
        isAskingRef.current = false;
        setIsAsking(false);
        abortControllerRef.current = null;
      }
    },
    [repositoryId, nodeId, edges, labelById, addAnswer, updateAnswer],
  );

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Cancels any in-flight request whenever the selected node changes -
  // covers both switching to a different node AND full unmount, since
  // React runs a useEffect's cleanup on both a dependency change and
  // unmount. The stream already correctly attributes its results to
  // the node that asked it (verified by tests), so this isn't a
  // correctness fix - it's here because letting a stream keep running
  // for a node nobody's looking at anymore wastes real backend/LLM
  // cost for no benefit, found in self-review.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [nodeId]);

  const clearHistory = useCallback(() => {
    // Clearing history has no effect on a request that's actually in
    // flight - it only clears what's already recorded, never
    // interrupts a live stream (cancel() is the correct call for that).
    clearHistoryInStore(nodeId);
  }, [nodeId, clearHistoryInStore]);

  return { history, ask, isAsking, cancel, clearHistory };
}

export { isAiGenerated };
export type { ArchitectureAnswer };
