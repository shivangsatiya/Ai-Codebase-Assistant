import {
  checkEveryEdgeReferencesExistingNodes,
  checkEveryNodeAndEdgeHasValidCertainty,
  checkNoDuplicateNodeIds,
  checkNoDuplicateEdgeIds,
  checkExactlyOneRepositoryRoot,
  checkCommitShaPresent,
  checkNoOrphanNodes,
  checkNoOrphanEdges,
  validateGraphInvariants,
} from '../src/services/knowledge-graph/graph-invariants';
import type { GraphNode, GraphEdge } from '../src/services/knowledge-graph/types';

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'file:a.ts',
    type: 'file',
    label: 'a.ts',
    filePath: 'a.ts',
    metadata: {},
    provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    ...overrides,
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'edge:file:a.ts->imports->file:b.ts',
    source: 'file:a.ts',
    target: 'file:b.ts',
    type: 'imports',
    metadata: {},
    provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    ...overrides,
  };
}

function makeRoot(): GraphNode {
  return makeNode({ id: 'repository:repo-1', type: 'repository', label: 'Repository', filePath: null });
}

describe('checkEveryEdgeReferencesExistingNodes', () => {
  it('passes when every edge endpoint exists among the nodes', () => {
    const nodes = [makeNode({ id: 'file:a.ts' }), makeNode({ id: 'file:b.ts' })];
    const edges = [makeEdge({ source: 'file:a.ts', target: 'file:b.ts' })];
    expect(checkEveryEdgeReferencesExistingNodes(nodes, edges)).toEqual([]);
  });

  it('catches a dangling source reference', () => {
    const nodes = [makeNode({ id: 'file:b.ts' })];
    const edges = [makeEdge({ source: 'file:nonexistent.ts', target: 'file:b.ts' })];
    const violations = checkEveryEdgeReferencesExistingNodes(nodes, edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('nonexistent');
  });

  it('catches a dangling target reference', () => {
    const nodes = [makeNode({ id: 'file:a.ts' })];
    const edges = [makeEdge({ source: 'file:a.ts', target: 'file:nonexistent.ts' })];
    expect(checkEveryEdgeReferencesExistingNodes(nodes, edges)).toHaveLength(1);
  });
});

describe('checkEveryNodeAndEdgeHasValidCertainty', () => {
  it('passes when every certainty value is valid', () => {
    const nodes = [makeNode()];
    const edges = [makeEdge()];
    expect(checkEveryNodeAndEdgeHasValidCertainty(nodes, edges)).toEqual([]);
  });

  it('catches an invalid certainty value on a node', () => {
    const nodes = [makeNode({ provenance: { ...makeNode().provenance, certainty: 'maybe' as never } })];
    expect(checkEveryNodeAndEdgeHasValidCertainty(nodes, [])).toHaveLength(1);
  });

  it('catches a missing certainty value on an edge', () => {
    const edges = [makeEdge({ provenance: undefined as never })];
    expect(checkEveryNodeAndEdgeHasValidCertainty([], edges)).toHaveLength(1);
  });
});

describe('checkNoDuplicateNodeIds / checkNoDuplicateEdgeIds', () => {
  it('passes for unique node ids', () => {
    expect(checkNoDuplicateNodeIds([makeNode({ id: 'a' }), makeNode({ id: 'b' })])).toEqual([]);
  });

  it('catches duplicate node ids', () => {
    expect(checkNoDuplicateNodeIds([makeNode({ id: 'a' }), makeNode({ id: 'a' })])).toHaveLength(1);
  });

  it('catches duplicate edge ids', () => {
    expect(checkNoDuplicateEdgeIds([makeEdge({ id: 'e1' }), makeEdge({ id: 'e1' })])).toHaveLength(1);
  });
});

describe('checkExactlyOneRepositoryRoot', () => {
  it('passes with exactly one repository-type node', () => {
    expect(checkExactlyOneRepositoryRoot([makeRoot(), makeNode()])).toEqual([]);
  });

  it('catches zero repository root nodes', () => {
    expect(checkExactlyOneRepositoryRoot([makeNode()])).toHaveLength(1);
  });

  it('catches more than one repository root node', () => {
    const violations = checkExactlyOneRepositoryRoot([makeRoot(), makeRoot()]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('2');
  });
});

describe('checkCommitShaPresent', () => {
  it('passes for a non-empty commit sha', () => {
    expect(checkCommitShaPresent('abc123')).toEqual([]);
  });

  it('catches an empty commit sha', () => {
    expect(checkCommitShaPresent('')).toHaveLength(1);
  });

  it('catches a whitespace-only commit sha', () => {
    expect(checkCommitShaPresent('   ')).toHaveLength(1);
  });
});

describe('checkNoOrphanNodes', () => {
  it('passes when every node is reachable from the root', () => {
    const nodes = [makeRoot(), makeNode({ id: 'folder:src' }), makeNode({ id: 'file:a.ts' })];
    const edges = [
      makeEdge({ id: 'e1', source: 'repository:repo-1', target: 'folder:src', type: 'contains' }),
      makeEdge({ id: 'e2', source: 'folder:src', target: 'file:a.ts', type: 'contains' }),
    ];
    expect(checkNoOrphanNodes(nodes, edges)).toEqual([]);
  });

  it('catches a node with no path back to the root - the real signature of an extraction bug', () => {
    const nodes = [makeRoot(), makeNode({ id: 'folder:src' }), makeNode({ id: 'file:orphan.ts' })];
    const edges = [makeEdge({ id: 'e1', source: 'repository:repo-1', target: 'folder:src', type: 'contains' })];
    // file:orphan.ts has no edge connecting it to anything.
    const violations = checkNoOrphanNodes(nodes, edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('file:orphan.ts');
  });

  it('does not double-report when there is no root at all - that is a different, already-reported problem', () => {
    const nodes = [makeNode({ id: 'file:a.ts' })];
    expect(checkNoOrphanNodes(nodes, [])).toEqual([]);
  });

  it('treats edges as undirected for reachability - an incoming-only edge still connects a node', () => {
    const nodes = [makeRoot(), makeNode({ id: 'file:a.ts' })];
    // Edge direction points AWAY from file:a.ts toward the root, not the
    // conventional "root contains file" direction - reachability should
    // still count this as connected.
    const edges = [makeEdge({ id: 'e1', source: 'file:a.ts', target: 'repository:repo-1', type: 'references' })];
    expect(checkNoOrphanNodes(nodes, edges)).toEqual([]);
  });
});

describe('checkNoOrphanEdges', () => {
  it('passes when both endpoints are valid graph members', () => {
    const nodes = [makeNode({ id: 'file:a.ts' }), makeNode({ id: 'file:b.ts' })];
    const edges = [makeEdge({ source: 'file:a.ts', target: 'file:b.ts' })];
    expect(checkNoOrphanEdges(nodes, edges)).toEqual([]);
  });

  it('catches an edge with an invalid endpoint', () => {
    const nodes = [makeNode({ id: 'file:a.ts' })];
    const edges = [makeEdge({ source: 'file:a.ts', target: 'file:nonexistent.ts' })];
    expect(checkNoOrphanEdges(nodes, edges)).toHaveLength(1);
  });
});

describe('validateGraphInvariants - the combined check', () => {
  it('returns no violations for a genuinely valid graph', () => {
    const nodes = [makeRoot(), makeNode({ id: 'file:a.ts' })];
    const edges = [makeEdge({ id: 'e1', source: 'repository:repo-1', target: 'file:a.ts', type: 'contains' })];
    expect(validateGraphInvariants('abc123', nodes, edges)).toEqual([]);
  });

  it('collects violations from multiple different invariants at once, not just the first one found', () => {
    // No root node (violates single-root) AND a dangling edge
    // (violates edge-references-existing-nodes) at the same time - a
    // failed generation's logged reasons should be genuinely
    // informative, not just "something was wrong."
    const nodes = [makeNode({ id: 'file:a.ts' })];
    const edges = [makeEdge({ source: 'file:a.ts', target: 'file:nonexistent.ts' })];
    const violations = validateGraphInvariants('abc123', nodes, edges);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});
