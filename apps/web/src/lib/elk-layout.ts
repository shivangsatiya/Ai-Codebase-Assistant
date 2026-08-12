import ELK from 'elkjs/lib/elk.bundled.js';
import type { FlowNode, FlowEdge } from '../lib/graph-adapter';

const elk = new ELK();

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;
const EXTERNAL_PACKAGES_CONTAINER_ID = '__external_packages__';

interface ElkTreeNode {
  id: string;
  width?: number;
  height?: number;
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
 * Which node types the React Flow renderer actually draws as an
 * expandable container versus a fixed-size flat card - checked
 * directly against GraphNode.tsx before writing this, not assumed.
 * GraphNode renders every single node type identically: a fixed
 * 180x56 card. Nothing in the current renderer draws a folder or file
 * as a larger box with other nodes visually inside it. `repository`
 * and `folder` are still given true ELK nesting below, but only
 * because their own direct children are themselves independently
 * rendered flat cards positioned near them - not because the renderer
 * draws them as literal containers either. Every other type (file,
 * function, class, interface, method, package, and every inferred
 * type) must never receive ELK `children` of its own.
 */
const CONTAINER_NODE_TYPES = new Set(['repository', 'folder']);

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
 *
 * Why does a file/symbol level ("depth > 0, not a container type")
 * never get ELK `children`, no matter how many symbols it contains?
 *
 * A real, live E2E test run against sindresorhus/is-fullwidth-code-point
 * found a genuine bug here: a file with one nested function was
 * rendered with the function's card visually overlapping the file's
 * own card. Traced to its actual root cause (not assumed): ELK's
 * compound-node layout computed a correctly *expanded* internal
 * container for the file to make room for its child - but
 * GraphNode.tsx never renders an expanded container; every node is
 * always the same fixed 180x56 flat card, so the child ended up
 * positioned "inside" a box that only existed in ELK's own math, never
 * on screen. The layout model and the rendering model must agree - so
 * a non-container node's own `contains`-descendants (its symbols, and
 * their own descendants if any) are promoted to be flat siblings under
 * the nearest genuine container ancestor instead of nested inside it.
 * The containment relationship itself is preserved and still fully
 * visible - through the real `contains` edge connecting the file to
 * each of its symbols - only the *visual layout* stops pretending the
 * file is a container it was never actually rendered as.
 */
function buildContainmentTree(nodes: FlowNode[], containsEdges: FlowEdge[]): ElkTreeNode[] {
  const childIdsByParent = new Map<string, string[]>();
  const parentIdByChild = new Map<string, string>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const edge of containsEdges) {
    if (!childIdsByParent.has(edge.source)) childIdsByParent.set(edge.source, []);
    childIdsByParent.get(edge.source)!.push(edge.target);
    parentIdByChild.set(edge.target, edge.source);
  }

  const allRootIds = nodes.filter((n) => !parentIdByChild.has(n.id)).map((n) => n.id);
  const hierarchyRootId = allRootIds.find((id) => (childIdsByParent.get(id)?.length ?? 0) > 0);
  const standaloneRootIds = allRootIds.filter((id) => id !== hierarchyRootId);

  /**
   * The hierarchy root is always treated as a genuine container,
   * regardless of its own declared nodeType - defensive against
   * silently dropping its entire subtree from the layout if the
   * backend ever sent unexpected type data for the root specifically,
   * rather than relying solely on 'repository' being in
   * CONTAINER_NODE_TYPES matching reality every time.
   */
  function isContainerType(id: string): boolean {
    if (id === hierarchyRootId) return true;
    const node = nodeById.get(id);
    return node ? CONTAINER_NODE_TYPES.has(node.data.nodeType) : false;
  }

  /**
   * Every `contains`-descendant of a non-container node, flattened -
   * used when a leaf-like node (a file, say) itself has children (its
   * symbols) that would otherwise need nesting the UI can't show.
   */
  function collectPromotedDescendants(id: string): string[] {
    const result: string[] = [];
    for (const childId of childIdsByParent.get(id) ?? []) {
      result.push(childId);
      result.push(...collectPromotedDescendants(childId));
    }
    return result;
  }

  /**
   * The flat list of node IDs that belong as direct ELK children of a
   * genuine container (repository/folder): its own direct
   * `contains`-children, with any non-container child's own
   * descendants promoted up to sit alongside it as siblings, rather
   * than nested beneath it. A nested folder child keeps its own
   * children where they are - handled separately, when buildNode
   * recurses into that folder - since a folder is itself a genuine
   * container.
   */
  function collectFlatChildIds(containerId: string): string[] {
    const result: string[] = [];
    for (const childId of childIdsByParent.get(containerId) ?? []) {
      result.push(childId);
      if (!isContainerType(childId)) {
        result.push(...collectPromotedDescendants(childId));
      }
    }
    return result;
  }

  /**
   * Returns 1 or 2 ELK tree entries for this node - never nested
   * `children` directly on the node's own real ID. A leaf-like node
   * (or a childless container) is just itself, fixed-size. A genuine
   * container WITH children is split into two separate entries: the
   * container itself, as a real, fixed-size leaf (since it's a real,
   * visible, fixed-size card too, not an invisible wrapper) - plus a
   * synthetic, never-rendered `<id>__children` wrapper holding its
   * flattened children, positioned near it by the outer rectpacking
   * pass. The same real pattern already proven correct for
   * EXTERNAL_PACKAGES_CONTAINER_ID, generalized to every container at
   * every depth - not just the outermost hierarchy root, since a real
   * E2E test run found the identical bug recurring for a nested
   * folder once the root-level case alone was fixed.
   */
  function buildNode(id: string): ElkTreeNode[] {
    if (!isContainerType(id)) {
      // Even if this node has its own real `contains`-children (a
      // file with symbols), those are laid out as flat siblings by
      // this node's own container ancestor (see collectFlatChildIds),
      // never nested inside this node's own ELK entry.
      return [{ id, width: NODE_WIDTH, height: NODE_HEIGHT }];
    }

    const flatChildIds = collectFlatChildIds(id);
    if (flatChildIds.length === 0) {
      return [{ id, width: NODE_WIDTH, height: NODE_HEIGHT }];
    }

    return [
      { id, width: NODE_WIDTH, height: NODE_HEIGHT },
      {
        id: `${id}__children`,
        children: flatChildIds.flatMap((childId) => buildNode(childId)),
        layoutOptions: { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '0.6' },
      },
    ];
  }

  const topLevelNodes: ElkTreeNode[] = [];

  if (hierarchyRootId) {
    topLevelNodes.push(...buildNode(hierarchyRootId));
  }

  if (standaloneRootIds.length > 0) {
    topLevelNodes.push({
      id: EXTERNAL_PACKAGES_CONTAINER_ID,
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
    // Excludes both EXTERNAL_PACKAGES_CONTAINER_ID and every dynamic
    // "<realNodeId>__children" synthetic wrapper buildNode generates
    // for a container - neither is ever a real, rendered node.
    if (node.id !== EXTERNAL_PACKAGES_CONTAINER_ID && !node.id.endsWith('__children')) {
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
