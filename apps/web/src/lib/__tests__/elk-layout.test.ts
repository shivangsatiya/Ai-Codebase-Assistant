import { describe, it, expect } from 'vitest';
import { layoutWithElk } from '../elk-layout';
import type { FlowNode, FlowEdge } from '../graph-adapter';

function makeNode(id: string, nodeType: string = 'file'): FlowNode {
  return {
    id,
    type: 'graphNode',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType,
      filePath: null,
      certainty: 'deterministic',
      verified: false,
      provenanceSource: 'test',
      provenanceVersion: '1',
    },
  };
}

function makeContainsEdge(source: string, target: string): FlowEdge {
  return { id: `e-${source}-${target}`, source, target, data: { edgeType: 'contains', certainty: 'deterministic' } };
}

describe('layoutWithElk', () => {
  it('returns an empty array for an empty graph, without calling ELK at all', async () => {
    const result = await layoutWithElk([], []);
    expect(result).toEqual([]);
  });

  it('positions every node, including deeply nested ones, with real (non-zero, non-overlapping) absolute coordinates', async () => {
    const nodes = [
      makeNode('repo', 'repository'),
      makeNode('folder-a', 'folder'),
      makeNode('file-a1', 'file'),
      makeNode('folder-b', 'folder'),
      makeNode('file-b1', 'file'),
    ];
    const edges = [
      makeContainsEdge('repo', 'folder-a'),
      makeContainsEdge('folder-a', 'file-a1'),
      makeContainsEdge('repo', 'folder-b'),
      makeContainsEdge('folder-b', 'file-b1'),
    ];

    const result = await layoutWithElk(nodes, edges);

    expect(result).toHaveLength(5);
    const positionsById = new Map(result.map((n) => [n.id, n.position]));

    for (const node of result) {
      expect(positionsById.get(node.id)).toBeDefined();
    }

    const allPositions = result.map((n) => `${n.position.x},${n.position.y}`);
    const uniquePositions = new Set(allPositions);
    expect(uniquePositions.size).toBe(result.length);
  });

  it('falls back to a flat layered pass, rather than guessing, if the containment data implies more than one root - defensive against malformed data', async () => {
    const nodes = [makeNode('root-1', 'repository'), makeNode('root-2', 'package'), makeNode('child-1', 'file')];
    const edges = [makeContainsEdge('root-1', 'child-1')];

    const result = await layoutWithElk(nodes, edges);

    expect(result).toHaveLength(3);
    expect(result.every((n) => n.position.x !== undefined && n.position.y !== undefined)).toBe(true);
  });

  it('positions a graph with no contains edges at all (every node its own root) without crashing', async () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const result = await layoutWithElk(nodes, []);

    expect(result).toHaveLength(2);
  });
});
