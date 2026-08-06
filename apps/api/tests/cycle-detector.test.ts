import { CycleDetector } from '../src/services/knowledge-graph/algorithms/cycle-detector';
import type { GraphEdge } from '../src/services/knowledge-graph/types';

function edge(source: string, target: string, type = 'imports'): GraphEdge {
  return {
    id: `edge:${source}->${type}->${target}`,
    source,
    target,
    type,
    metadata: {},
    provenance: { source: 'test', sourceVersion: '1', certainty: 'deterministic', verified: false },
  };
}

describe('CycleDetector', () => {
  const detector = new CycleDetector();

  it('reports no cycles for a graph with no import edges at all', () => {
    const result = detector.run({ nodes: [], edges: [] });
    expect(result.cycleCount).toBe(0);
  });

  it('reports no cycles for a simple linear chain A -> B -> C', () => {
    const edges = [edge('A', 'B'), edge('B', 'C')];
    const result = detector.run({ nodes: [], edges });
    expect(result.cycleCount).toBe(0);
  });

  it('detects a direct 2-node cycle A -> B -> A', () => {
    const edges = [edge('A', 'B'), edge('B', 'A')];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(1);
    expect(result.cycles[0]!.sort()).toEqual(['A', 'B']);
  });

  it("detects a 3-node cycle A -> B -> C -> A - the case verified by hand-tracing Tarjan's algorithm before writing this test", () => {
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(1);
    expect(result.cycles[0]!.sort()).toEqual(['A', 'B', 'C']);
  });

  it('detects a self-loop (a file importing itself) as its own single-node cycle', () => {
    const edges = [edge('A', 'A')];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(1);
    expect(result.cycles[0]).toEqual(['A']);
  });

  it('detects two independent cycles in the same graph as two separate cycles', () => {
    const edges = [
      edge('A', 'B'),
      edge('B', 'A'), // cycle 1: A, B
      edge('X', 'Y'),
      edge('Y', 'Z'),
      edge('Z', 'X'), // cycle 2: X, Y, Z
      edge('B', 'X'), // connects the two components, but not into one cycle
    ];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(2);
    const sortedCycles = result.cycles.map((c) => [...c].sort()).sort((a, b) => a.length - b.length);
    expect(sortedCycles).toEqual([
      ['A', 'B'],
      ['X', 'Y', 'Z'],
    ]);
  });

  it('does not consider contains edges when detecting cycles, even if present', () => {
    // contains edges are always root-to-child by construction and would
    // never form a real cycle - but this confirms the filter is actually
    // scoped to 'imports' type specifically, not just "whatever edges
    // happen to be there."
    const edges = [edge('A', 'B', 'contains'), edge('B', 'A', 'contains')];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(0);
  });

  it('a more complex graph with a cycle nested among non-cyclic edges still finds exactly the real cycle', () => {
    const edges = [
      edge('root', 'A'),
      edge('root', 'B'),
      edge('A', 'C'),
      edge('C', 'D'),
      edge('D', 'C'), // the only real cycle: C <-> D
      edge('B', 'E'),
    ];
    const result = detector.run({ nodes: [], edges });

    expect(result.cycleCount).toBe(1);
    expect(result.cycles[0]!.sort()).toEqual(['C', 'D']);
  });
});
