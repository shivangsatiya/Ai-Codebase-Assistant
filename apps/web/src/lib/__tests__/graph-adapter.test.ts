import { describe, it, expect } from 'vitest';
import { adaptGraph, adaptBackendNode } from '../graph-adapter';
import type { BackendGraphNode, BackendGraphEdge } from '../graph-api';

function makeNode(overrides: Partial<BackendGraphNode> = {}): BackendGraphNode {
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

function makeEdge(overrides: Partial<BackendGraphEdge> = {}): BackendGraphEdge {
  return {
    id: 'edge:1',
    source: 'file:a.ts',
    target: 'file:b.ts',
    type: 'imports',
    metadata: {},
    provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    ...overrides,
  };
}

describe('adaptBackendNode', () => {
  it('maps a real, well-formed backend node correctly', () => {
    const node = makeNode({ id: 'class:x.ts#Foo', type: 'class', label: 'Foo' });
    const result = adaptBackendNode(node);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('class:x.ts#Foo');
    expect(result!.data.nodeType).toBe('class');
    expect(result!.data.label).toBe('Foo');
    expect(result!.data.certainty).toBe('deterministic');
  });

  it('returns null for a node missing an id, rather than producing a broken React Flow node', () => {
    const node = makeNode({ id: '' });
    expect(adaptBackendNode(node)).toBeNull();
  });

  it('returns null for a node with an invalid certainty value', () => {
    const node = makeNode({ provenance: { ...makeNode().provenance, certainty: 'maybe' as never } });
    expect(adaptBackendNode(node)).toBeNull();
  });
});

describe('adaptGraph - nodes', () => {
  it('maps every well-formed node', () => {
    const result = adaptGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], []);
    expect(result.nodes).toHaveLength(2);
    expect(result.droppedNodeCount).toBe(0);
  });

  it('drops malformed nodes without throwing, and reports how many were dropped', () => {
    const result = adaptGraph([makeNode({ id: 'good' }), makeNode({ id: '' })], []);
    expect(result.nodes).toHaveLength(1);
    expect(result.droppedNodeCount).toBe(1);
  });
});

describe('adaptGraph - edges', () => {
  it('maps a well-formed edge between two known nodes', () => {
    const nodes = [makeNode({ id: 'file:a.ts' }), makeNode({ id: 'file:b.ts' })];
    const result = adaptGraph(nodes, [makeEdge()]);

    expect(result.edges).toHaveLength(1);
    expect(result.droppedEdgeCount).toBe(0);
  });

  it('drops an edge referencing a node that does not exist in the node set, without throwing - defensive even though the backend already guarantees this cannot happen', () => {
    const nodes = [makeNode({ id: 'file:a.ts' })];
    const result = adaptGraph(nodes, [makeEdge()]);

    expect(result.edges).toHaveLength(0);
    expect(result.droppedEdgeCount).toBe(1);
  });

  it('separates contains edges from other edge types for the ELK layout boundary', () => {
    const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c' })];
    const edges = [
      makeEdge({ id: 'e1', source: 'a', target: 'b', type: 'contains' }),
      makeEdge({ id: 'e2', source: 'a', target: 'c', type: 'imports' }),
    ];
    const result = adaptGraph(nodes, edges);

    expect(result.edges).toHaveLength(2);
    expect(result.containsEdges).toHaveLength(1);
    expect(result.containsEdges[0]!.id).toBe('e1');
  });

  it('drops a malformed edge (missing type) without throwing', () => {
    const nodes = [makeNode({ id: 'file:a.ts' }), makeNode({ id: 'file:b.ts' })];
    const result = adaptGraph(nodes, [makeEdge({ type: '' })]);

    expect(result.edges).toHaveLength(0);
    expect(result.droppedEdgeCount).toBe(1);
  });
});
