import type { FlowEdge } from '../lib/graph-adapter';

/**
 * Why two tiers, not a distinct color per edge type?
 *
 * "Different edge types should be visually distinguishable without
 * overwhelming the graph" is a real tension, not a checklist to
 * maximize both sides of independently. A repository-scale graph can
 * have dozens of relationship types across hundreds of edges - a full
 * color-per-type legend would be exactly the "overwhelming" outcome
 * this is meant to avoid. The genuinely important distinction is
 * structural (`contains`, which already IS the layout skeleton ELK
 * used, and doesn't need to draw the eye) versus relational (every
 * cross-cutting edge - imports, calls, depends_on, and the rest -
 * which is what a user actually came here to see). Two tiers draws
 * that real line clearly; more than that adds detail without adding
 * clarity at this scale.
 */
export function styleEdge(edge: FlowEdge): FlowEdge {
  const isStructural = edge.data?.edgeType === 'contains';

  return {
    ...edge,
    style: isStructural ? { stroke: '#262b3a', strokeWidth: 1 } : { stroke: '#565d70', strokeWidth: 1.5 },
    animated: false,
  };
}

export function styleEdges(edges: FlowEdge[]): FlowEdge[] {
  return edges.map(styleEdge);
}
