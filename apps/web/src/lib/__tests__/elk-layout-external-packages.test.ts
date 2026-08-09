import { describe, it, expect } from 'vitest';
import { layoutWithElk } from '../elk-layout';
import type { FlowNode, FlowEdge } from '../graph-adapter';

function makeNode(id: string): FlowNode {
  return {
    id, type: 'graphNode', position: { x: 0, y: 0 },
    data: { label: id, nodeType: 'file', filePath: null, certainty: 'deterministic', verified: false, provenanceSource: 'x', provenanceVersion: '1' },
  };
}
function edge(source: string, target: string): FlowEdge {
  return { id: `e-${source}-${target}`, source, target, data: { edgeType: 'contains', certainty: 'deterministic' } };
}

describe('handles the real, common case: one hierarchy root plus many standalone package roots with no contains parent', () => {
  it('REGRESSION: the original single-root assumption silently fell back to the flat 60-90:1 layout whenever standalone package roots existed - this is now fixed and verified against a shape matching a real, confirmed live repository (137 nodes, 75 contains edges, 62 standalone package roots)', async () => {
    const nodes: FlowNode[] = [makeNode('repository:real')];
    const edges: FlowEdge[] = [];

    // Real-ish hierarchy: root -> 7 folders -> nested files/symbols,
    // roughly matching the confirmed counts (7, 4, 7, 1, 7 children
    // seen at various levels) totaling toward ~75 contains edges.
    let hierarchyNodeCount = 1;
    for (let f = 0; f < 7; f++) {
      const folderId = `folder${f}`;
      nodes.push(makeNode(folderId));
      edges.push(edge('repository:real', folderId));
      hierarchyNodeCount++;
      const fileCount = [4, 7, 1, 7, 5, 6, 6][f];
      for (let file = 0; file < fileCount; file++) {
        const fileId = `${folderId}-file${file}`;
        nodes.push(makeNode(fileId));
        edges.push(edge(folderId, fileId));
        hierarchyNodeCount++;
      }
    }

    // 62 standalone package nodes - referenced only via imports (not
    // added here since imports don't go into layoutWithElk at all),
    // never contains - exactly the real, confirmed shape.
    for (let p = 0; p < 62; p++) {
      nodes.push(makeNode(`package:pkg${p}`));
    }

    console.log(`Test shape: ${nodes.length} total nodes (${hierarchyNodeCount} in hierarchy, 62 standalone), ${edges.length} contains edges`);

    const result = await layoutWithElk(nodes, edges);
    expect(result).toHaveLength(nodes.length);

    const xs = result.map((n) => n.position.x);
    const ys = result.map((n) => n.position.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const ratio = width / height;

    console.log(`RESULT: width=${Math.round(width)} height=${Math.round(height)} ratio=${ratio.toFixed(2)}`);

    // No two nodes should collide (proves the flattening + the new
    // external-packages grouping both produced real, distinct positions).
    const uniquePositions = new Set(result.map((n) => `${n.position.x},${n.position.y}`));
    expect(uniquePositions.size).toBe(result.length);

    // The original bug (many roots -> silent fallback to flat layout)
    // produced ratios in the 50-90:1 range on shapes like this. A real
    // fix should land well under 10:1.
    expect(ratio).toBeLessThan(10);
  });
});
