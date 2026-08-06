import type { GraphNode, GraphEdge } from './types';

/**
 * Every check returns a list of violation messages (empty if none) -
 * collecting ALL violations rather than stopping at the first one, so a
 * failed generation attempt's logged reasons are actually informative,
 * not just "something was wrong."
 */

export function checkEveryEdgeReferencesExistingNodes(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const violations: string[] = [];
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      violations.push(`Edge "${edge.id}" references nonexistent source node "${edge.source}"`);
    }
    if (!nodeIds.has(edge.target)) {
      violations.push(`Edge "${edge.id}" references nonexistent target node "${edge.target}"`);
    }
  }
  return violations;
}

export function checkEveryNodeAndEdgeHasValidCertainty(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const valid = new Set(['deterministic', 'inferred']);
  const violations: string[] = [];
  for (const node of nodes) {
    if (!valid.has(node.provenance?.certainty)) {
      violations.push(`Node "${node.id}" has an invalid or missing certainty level`);
    }
  }
  for (const edge of edges) {
    if (!valid.has(edge.provenance?.certainty)) {
      violations.push(`Edge "${edge.id}" has an invalid or missing certainty level`);
    }
  }
  return violations;
}

export function checkNoDuplicateNodeIds(nodes: GraphNode[]): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      violations.push(`Duplicate node id "${node.id}" - deduplication should have already prevented this`);
    }
    seen.add(node.id);
  }
  return violations;
}

export function checkNoDuplicateEdgeIds(edges: GraphEdge[]): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) {
      violations.push(`Duplicate edge id "${edge.id}" - deduplication should have already prevented this`);
    }
    seen.add(edge.id);
  }
  return violations;
}

export function checkExactlyOneRepositoryRoot(nodes: GraphNode[]): string[] {
  const roots = nodes.filter((n) => n.type === 'repository');
  if (roots.length === 0) {
    return ['Graph has no repository root node'];
  }
  if (roots.length > 1) {
    return [`Graph has ${roots.length} repository root nodes, expected exactly 1`];
  }
  return [];
}

export function checkCommitShaPresent(commitSha: string): string[] {
  return commitSha && commitSha.trim().length > 0 ? [] : ['Graph is missing a commit SHA'];
}

/**
 * Reachability from the repository root, via any edge regardless of
 * direction - a node produced by an extractor but never correctly
 * connected to anything is exactly the kind of real extraction bug this
 * check exists to catch before it reaches a user.
 */
export function checkNoOrphanNodes(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const root = nodes.find((n) => n.type === 'repository');
  if (!root) {
    // The "exactly one root" check already reports this specific
    // problem - no need to also report every node as orphaned when the
    // real root cause is "there's no root to be reachable from at all."
    return [];
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push(edge.target);
    adjacency.get(edge.target)!.push(edge.source);
  }

  const reachable = new Set<string>([root.id]);
  const queue = [root.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return nodes
    .filter((n) => n.id !== root.id && !reachable.has(n.id))
    .map((n) => `Node "${n.id}" is orphaned - not reachable from the repository root`);
}

export function checkNoOrphanEdges(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  // The edge-side complement of checkEveryEdgeReferencesExistingNodes -
  // kept as its own named check to match the design's invariant table
  // one-to-one, even though the implementation overlaps: this one
  // specifically asserts BOTH endpoints are valid graph members, not
  // just that a reference string happens to match something.
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges
    .filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target))
    .map((e) => `Edge "${e.id}" is orphaned - one or both endpoints are not valid graph members`);
}

/**
 * Runs every invariant and returns the combined list of violations
 * (empty means the graph is valid). This is the single function the
 * pipeline calls - each individual check above stays independently
 * testable and independently named, matching the design's own table.
 */
export function validateGraphInvariants(commitSha: string, nodes: GraphNode[], edges: GraphEdge[]): string[] {
  return [
    ...checkEveryEdgeReferencesExistingNodes(nodes, edges),
    ...checkEveryNodeAndEdgeHasValidCertainty(nodes, edges),
    ...checkNoDuplicateNodeIds(nodes),
    ...checkNoDuplicateEdgeIds(edges),
    ...checkExactlyOneRepositoryRoot(nodes),
    ...checkCommitShaPresent(commitSha),
    ...checkNoOrphanNodes(nodes, edges),
    ...checkNoOrphanEdges(nodes, edges),
  ];
}
