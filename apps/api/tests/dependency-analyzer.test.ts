import { DependencyAnalyzer } from '../src/services/knowledge-graph/algorithms/dependency-analyzer';
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

describe('DependencyAnalyzer - direct mode', () => {
  const analyzer = new DependencyAnalyzer();

  it('returns outgoing neighbors only when direction is "outgoing"', () => {
    const edges = [edge('A', 'B'), edge('C', 'A')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', direction: 'outgoing' });
    expect(result.nodeIds).toEqual(['B']);
  });

  it('returns incoming neighbors only when direction is "incoming"', () => {
    const edges = [edge('A', 'B'), edge('C', 'A')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', direction: 'incoming' });
    expect(result.nodeIds).toEqual(['C']);
  });

  it('returns both directions by default', () => {
    const edges = [edge('A', 'B'), edge('C', 'A')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A' });
    expect(result.nodeIds.sort()).toEqual(['B', 'C']);
  });

  it('throws a clear validation error when nodeId is missing for direct mode', () => {
    const analyzer2 = new DependencyAnalyzer();
    expect(() => analyzer2.run({ nodes: [], edges: [] }, { mode: 'direct' })).toThrow(/nodeId/);
  });

  it('respects an edgeType filter, ignoring edges of other types', () => {
    const edges = [edge('A', 'B', 'imports'), edge('A', 'C', 'contains')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', edgeType: 'imports' });
    expect(result.nodeIds).toEqual(['B']);
  });
});

describe('DependencyAnalyzer - transitive mode', () => {
  const analyzer = new DependencyAnalyzer();

  it('finds the full transitive closure, not just direct neighbors', () => {
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', direction: 'outgoing', mode: 'transitive' });
    expect(result.nodeIds.sort()).toEqual(['B', 'C', 'D']);
  });

  it('does not include the starting node itself in the closure', () => {
    const edges = [edge('A', 'B'), edge('B', 'A')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', direction: 'outgoing', mode: 'transitive' });
    expect(result.nodeIds).not.toContain('A');
  });

  it('correctly handles branching - multiple paths converging on the same node counted once', () => {
    const edges = [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')];
    const result = analyzer.run({ nodes: [], edges }, { nodeId: 'A', direction: 'outgoing', mode: 'transitive' });
    expect(result.nodeIds.sort()).toEqual(['B', 'C', 'D']);
  });
});

describe('DependencyAnalyzer - path mode', () => {
  const analyzer = new DependencyAnalyzer();

  it('finds a real shortest path between two connected nodes', () => {
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const result = analyzer.run({ nodes: [], edges }, { mode: 'path', from: 'A', to: 'D' });
    expect(result.path).toEqual(['A', 'B', 'C', 'D']);
  });

  it('finds the SHORTEST path when multiple paths exist, not just any path', () => {
    const edges = [edge('A', 'D'), edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const result = analyzer.run({ nodes: [], edges }, { mode: 'path', from: 'A', to: 'D' });
    expect(result.path).toEqual(['A', 'D']);
  });

  it('returns null when no path exists', () => {
    const edges = [edge('A', 'B')];
    const result = analyzer.run({ nodes: [], edges }, { mode: 'path', from: 'A', to: 'C' });
    expect(result.path).toBeNull();
  });

  it('returns a single-element path when from and to are the same node', () => {
    const result = analyzer.run({ nodes: [], edges: [] }, { mode: 'path', from: 'A', to: 'A' });
    expect(result.path).toEqual(['A']);
  });

  it('throws a clear validation error when "from" or "to" is missing', () => {
    expect(() => analyzer.run({ nodes: [], edges: [] }, { mode: 'path', from: 'A' })).toThrow(/from.*to|to.*from/);
  });
});
