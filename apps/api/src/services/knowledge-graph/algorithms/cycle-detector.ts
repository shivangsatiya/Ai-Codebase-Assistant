import type { IArchitectureAlgorithm, GraphInput } from '../architecture-intelligence-engine';

export interface CycleDetectionResult {
  cycles: string[][];
  cycleCount: number;
}

/**
 * Why Tarjan's algorithm specifically, over import edges only?
 *
 * Tarjan's is the standard, correct algorithm for finding every
 * strongly-connected component of a directed graph in one linear-time
 * pass - a cycle is exactly an SCC with more than one member (or a
 * single node with a self-loop). Scoped to `imports` edges only, not
 * `contains`: containment edges are always root-to-child by
 * construction (DeterministicExtractor never produces a folder/file
 * edge pointing the other way), so a cycle there would only ever
 * signal a bug in extraction, not a real architectural fact worth
 * surfacing to a user - imports are the relationship where real
 * circular dependencies actually occur.
 */
export class CycleDetector implements IArchitectureAlgorithm<CycleDetectionResult> {
  readonly name = 'cycle-detection';

  run(graph: GraphInput): CycleDetectionResult {
    const importEdges = graph.edges.filter((e) => e.type === 'imports');
    const adjacency = new Map<string, string[]>();
    const allNodeIds = new Set<string>();

    for (const edge of importEdges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source)!.push(edge.target);
      allNodeIds.add(edge.source);
      allNodeIds.add(edge.target);
    }

    const sccs = this.tarjanSCC(allNodeIds, adjacency);

    // A cycle is an SCC with more than one node, or a single node with
    // a direct self-loop (a file importing itself).
    const cycles = sccs.filter((scc) => {
      if (scc.length > 1) return true;
      const [nodeId] = scc;
      return (adjacency.get(nodeId!) ?? []).includes(nodeId!);
    });

    return { cycles, cycleCount: cycles.length };
  }

  private tarjanSCC(allNodeIds: Set<string>, adjacency: Map<string, string[]>): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongconnect = (v: string): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adjacency.get(v) ?? []) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    };

    for (const nodeId of allNodeIds) {
      if (!indices.has(nodeId)) {
        strongconnect(nodeId);
      }
    }

    return sccs;
  }
}
