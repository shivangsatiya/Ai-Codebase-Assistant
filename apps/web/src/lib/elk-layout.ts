import ELK from 'elkjs/lib/elk.bundled.js';
import type { FlowNode, FlowEdge } from '../lib/graph-adapter';

const elk = new ELK();

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;
const EXTERNAL_PACKAGES_CONTAINER_ID = '__external_packages__';

interface ElkTreeNode {
  id: string;
  width: number;
  height: number;
  children?: ElkTreeNode[];
  layoutOptions?: Record<string, string>;
}

interface ElkLayoutResultNode {
  id: string;
  x?: number;
  y?: number;
  children?: ElkLayoutResultNode[];
}

/**
 * Why only `contains` edges drive the layout - restated, still true:
 *
 * Only `contains` edges are given to ELK; every other edge type is
 * still rendered afterward, connecting the resulting positions, but
 * never influences where a node is placed.
 *
 * Why true nested children, when a flat `elk.layered` pass over all
 * `contains` edges was the original, deliberately simpler choice?
 *
 * That original choice was wrong in practice: a flat layered pass
 * produces one row per containment level, and a level with many
 * siblings and no edges between them becomes one extremely wide row -
 * measured at roughly 60:1 width-to-height on a realistic synthetic
 * shape. `rectpacking`, applied to each nested container, fixes this -
 * measured bringing that same shape down to roughly 1.6:1.
 *
 * Why is there a separate "roots.length === 1" case handled explicitly
 * rather than assumed, and why an EXTERNAL_PACKAGES_CONTAINER at all?
 *
 * A real repository graph, checked directly against a live example
 * rather than assumed, has ONE genuine hierarchy root plus MANY
 * additional "roots" with no children and no `contains` parent at all -
 * package nodes (external npm dependencies), which are referenced only
 * via `imports` edges, never `contains`. A 137-node real graph produced
 * 62 such roots. The original version of this function treated more
 * than one root as malformed data and fell back to the very flat
 * layout this whole rewrite exists to avoid - which silently meant the
 * fix never actually ran on real data at all, only on synthetic tests
 * that happened to have exactly one root. The real fix: find the one
 * root that actually has children (the genuine repository root) and
 * give it the full nested treatment; group every other, childless root
 * into one synthetic container laid out with the same `rectpacking`
 * approach, so loose package references get a compact cluster instead
 * of either crashing the single-root assumption or reverting to a flat
 * layout for the entire graph because of them.
 */
function buildContainmentTree(nodes: FlowNode[], containsEdges: FlowEdge[]): ElkTreeNode[] {
  const childIdsByParent = new Map<string, string[]>();
  const parentIdByChild = new Map<string, string>();

  for (const edge of containsEdges) {
    if (!childIdsByParent.has(edge.source)) childIdsByParent.set(edge.source, []);
    childIdsByParent.get(edge.source)!.push(edge.target);
    parentIdByChild.set(edge.target, edge.source);
  }

  function buildNode(id: string, depth: number): ElkTreeNode {
    const childIds = childIdsByParent.get(id) ?? [];
    if (childIds.length === 0) {
      return { id, width: NODE_WIDTH, height: NODE_HEIGHT };
    }
    return {
      id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      children: childIds.map((childId) => buildNode(childId, depth + 1)),
      layoutOptions:
        depth === 0
          ? { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN' }
          : { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '0.6' },
    };
  }

  const allRootIds = nodes.filter((n) => !parentIdByChild.has(n.id)).map((n) => n.id);
  const hierarchyRootId = allRootIds.find((id) => (childIdsByParent.get(id)?.length ?? 0) > 0);
  const standaloneRootIds = allRootIds.filter((id) => id !== hierarchyRootId);

  const topLevelNodes: ElkTreeNode[] = [];

  if (hierarchyRootId) {
    topLevelNodes.push(buildNode(hierarchyRootId, 0));
  }

  if (standaloneRootIds.length > 0) {
    topLevelNodes.push({
      id: EXTERNAL_PACKAGES_CONTAINER_ID,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      children: standaloneRootIds.map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT })),
      layoutOptions: { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '1.6' },
    });
  }

  // A graph with no genuine hierarchy root at all (every node
  // childless, e.g. an empty or malformed graph) - every node becomes
  // its own top-level entry rather than nesting under a synthetic
  // container that would falsely imply they're related.
  if (!hierarchyRootId && standaloneRootIds.length === 0) {
    return nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT }));
  }

  return topLevelNodes;
}

/**
 * ELK returns each nested child's position relative to its immediate
 * parent container, not an absolute page position - verified
 * empirically before writing this, not assumed. Absolute position is
 * the running sum of every ancestor's own position.
 */
function flattenToAbsolutePositions(
  resultNodes: ElkLayoutResultNode[],
  offsetX: number,
  offsetY: number,
  positions: Map<string, { x: number; y: number }>,
): void {
  for (const node of resultNodes) {
    const absoluteX = offsetX + (node.x ?? 0);
    const absoluteY = offsetY + (node.y ?? 0);
    if (node.id !== EXTERNAL_PACKAGES_CONTAINER_ID) {
      positions.set(node.id, { x: absoluteX, y: absoluteY });
    }
    if (node.children) {
      flattenToAbsolutePositions(node.children, absoluteX, absoluteY, positions);
    }
  }
}

export async function layoutWithElk(nodes: FlowNode[], containsEdges: FlowEdge[]): Promise<FlowNode[]> {
  if (nodes.length === 0) return [];

  const topLevelNodes = buildContainmentTree(nodes, containsEdges);

  const elkGraph = {
    id: '__layout_root__',
    layoutOptions: { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '1.6' },
    children: topLevelNodes,
    edges: [],
  };

  const layouted = (await elk.layout(elkGraph)) as ElkLayoutResultNode;
  const positions = new Map<string, { x: number; y: number }>();
  flattenToAbsolutePositions(layouted.children ?? [], 0, 0, positions);

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
  }));
}
