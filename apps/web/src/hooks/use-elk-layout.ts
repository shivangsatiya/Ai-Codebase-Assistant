import { useEffect, useState } from 'react';
import { layoutWithElk } from '../lib/elk-layout';
import type { FlowNode, FlowEdge } from '../lib/graph-adapter';

/**
 * Why a dedicated hook rather than inline useEffect in the main
 * component?
 *
 * The layout computation is async (ELK.js), and its inputs need to be
 * STABLE references between renders - this only re-runs when `nodes`/
 * `containsEdges` are genuinely new (a real graph refetch), not on
 * every render of the parent, which the caller achieves by memoizing
 * the adapted graph upstream (see RepositoryGraph.tsx). A stale
 * closure guard (the `cancelled` flag) prevents a slow, superseded
 * layout call from overwriting a newer one if the graph changes again
 * before the first layout finishes.
 */
export function useElkLayout(nodes: FlowNode[], containsEdges: FlowEdge[]) {
  const [layoutedNodes, setLayoutedNodes] = useState<FlowNode[]>([]);
  const [isLayouting, setIsLayouting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLayouting(true);
    // Milestone 4 Task 5 - measurement only. Real ELK layout timing,
    // logged so it's capturable during an actual benchmark run.
    const layoutStartedAt = performance.now();

    layoutWithElk(nodes, containsEdges)
      .then((result) => {
        if (!cancelled) {
          const layoutDurationMs = Math.round(performance.now() - layoutStartedAt);
          // eslint-disable-next-line no-console
          console.log(`[benchmark] ELK layout: ${layoutDurationMs}ms (${result.length} nodes)`);
          setLayoutedNodes(result);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLayouting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [nodes, containsEdges]);

  return { layoutedNodes, isLayouting };
}
