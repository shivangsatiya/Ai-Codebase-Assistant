import type { FlowEdge } from './graph-adapter';

export interface NodeRelationships {
  incomingCount: number;
  outgoingCount: number;
  relatedNodeIds: Set<string>;
  relatedEdgeIds: Set<string>;
}

/**
 * Pure, synchronous, computed entirely from the already-fetched edges
 * array - the single function both hover (instant, per §10) and node
 * selection (relationship highlighting, per §12) call, so there's one
 * place this logic lives rather than two slightly-different
 * implementations for what's conceptually the same computation.
 */
export function computeNodeRelationships(nodeId: string, edges: FlowEdge[]): NodeRelationships {
  let incomingCount = 0;
  let outgoingCount = 0;
  const relatedNodeIds = new Set<string>();
  const relatedEdgeIds = new Set<string>();

  for (const edge of edges) {
    if (edge.source === nodeId) {
      outgoingCount++;
      relatedNodeIds.add(edge.target);
      relatedEdgeIds.add(edge.id);
    } else if (edge.target === nodeId) {
      incomingCount++;
      relatedNodeIds.add(edge.source);
      relatedEdgeIds.add(edge.id);
    }
  }

  return { incomingCount, outgoingCount, relatedNodeIds, relatedEdgeIds };
}
