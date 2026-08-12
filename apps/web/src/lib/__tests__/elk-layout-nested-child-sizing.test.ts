import { describe, it, expect } from 'vitest';
import { layoutWithElk } from '../elk-layout';
import type { FlowNode, FlowEdge } from '../graph-adapter';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

function makeNode(id: string, nodeType: string): FlowNode {
  return {
    id,
    type: 'graphNode',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType,
      certainty: 'deterministic',
      verified: true,
      provenanceSource: 'DeterministicExtractor',
      provenanceVersion: '1.0.0',
      filePath: id,
    },
  };
}

function makeContainsEdge(source: string, target: string): FlowEdge {
  return { id: `${source}->${target}`, source, target, data: { edgeType: 'contains', certainty: 'deterministic' } };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const aRight = a.x + NODE_WIDTH;
  const aBottom = a.y + NODE_HEIGHT;
  const bRight = b.x + NODE_WIDTH;
  const bBottom = b.y + NODE_HEIGHT;
  return a.x < bRight && aRight > b.x && a.y < bBottom && aBottom > b.y;
}

/**
 * Layout contract, established directly per the approved design
 * decision: no two independently rendered nodes may occupy
 * overlapping visual bounds. Tested here at the layout/adapter level,
 * not left to visual inspection alone - the exact protection this
 * suite exists to provide against this class of bug recurring.
 */
function assertNoOverlaps(positions: Map<string, { x: number; y: number }>) {
  const entries = Array.from(positions.entries());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, posA] = entries[i];
      const [idB, posB] = entries[j];
      expect(overlaps(posA, posB), `${idA} should not overlap ${idB}`).toBe(false);
    }
  }
}

describe('layoutWithElk - flattened symbol visualization (approved design decision)', () => {
  it(
    'REGRESSION: reproduces the real structure found via a live E2E test run against ' +
      'sindresorhus/is-fullwidth-code-point (a file with one nested function overlapped it) - ' +
      'extended to the full required shape: Repository -> Folder -> File -> Symbol, with a ' +
      'function, a class, and an external package. No two nodes should ever overlap.',
    async () => {
      const nodes = [
        makeNode('repo', 'repository'),
        makeNode('src', 'folder'),
        makeNode('index.js', 'file'),
        makeNode('isFullwidthCodePoint', 'function'),
        makeNode('utils.js', 'file'),
        makeNode('Formatter', 'class'),
        makeNode('readme.md', 'file'),
        // An external package - a real root with no contains parent at
        // all, referenced only via `imports`, matching the real,
        // confirmed shape from the earlier external-packages
        // regression test.
        makeNode('package:ansi-regex', 'package'),
      ];

      const edges = [
        makeContainsEdge('repo', 'src'),
        makeContainsEdge('repo', 'readme.md'),
        makeContainsEdge('src', 'index.js'),
        makeContainsEdge('src', 'utils.js'),
        makeContainsEdge('index.js', 'isFullwidthCodePoint'),
        makeContainsEdge('utils.js', 'Formatter'),
      ];

      const result = await layoutWithElk(nodes, edges);
      const positions = new Map(result.map((n) => [n.id, n.position]));

      // 1. Every graph node receives a layout position.
      for (const node of nodes) {
        expect(positions.get(node.id), `${node.id} should have a real position`).toBeDefined();
      }

      // 2. Every node has a known rendered dimension - implicit here:
      // the overlap check below only makes sense because every node
      // uses the same real, fixed NODE_WIDTH/NODE_HEIGHT the actual
      // GraphNode component renders at, not a computed/expanded size
      // that doesn't correspond to anything on screen.

      // 3 & 4. Symbol nodes are not nested compound children, and do
      // not overlap their containing file.
      const indexJs = positions.get('index.js')!;
      const symbolOfIndexJs = positions.get('isFullwidthCodePoint')!;
      expect(overlaps(indexJs, symbolOfIndexJs), 'index.js should not overlap its function isFullwidthCodePoint').toBe(false);

      const utilsJs = positions.get('utils.js')!;
      const classInUtils = positions.get('Formatter')!;
      expect(overlaps(utilsJs, classInUtils), 'utils.js should not overlap its class Formatter').toBe(false);

      // 5. No unrelated nodes overlap anywhere in the graph.
      assertNoOverlaps(positions);

      // 6. The resulting layout remains within sane, finite bounds -
      // no node position is NaN, negative-infinity, or otherwise
      // degenerate.
      for (const [id, pos] of positions.entries()) {
        expect(Number.isFinite(pos.x), `${id} x position should be finite`).toBe(true);
        expect(Number.isFinite(pos.y), `${id} y position should be finite`).toBe(true);
      }
    },
  );

  it('a file with multiple symbols places every symbol as an independent, non-overlapping sibling', async () => {
    const nodes = [
      makeNode('repo', 'repository'),
      makeNode('big-file.js', 'file'),
      makeNode('funcA', 'function'),
      makeNode('funcB', 'function'),
      makeNode('ClassC', 'class'),
      makeNode('InterfaceD', 'interface'),
    ];

    const edges = [
      makeContainsEdge('repo', 'big-file.js'),
      makeContainsEdge('big-file.js', 'funcA'),
      makeContainsEdge('big-file.js', 'funcB'),
      makeContainsEdge('big-file.js', 'ClassC'),
      makeContainsEdge('big-file.js', 'InterfaceD'),
    ];

    const result = await layoutWithElk(nodes, edges);
    const positions = new Map(result.map((n) => [n.id, n.position]));

    for (const node of nodes) {
      expect(positions.get(node.id)).toBeDefined();
    }

    assertNoOverlaps(positions);
  });
});
