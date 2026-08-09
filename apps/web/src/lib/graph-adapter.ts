import type { Node as RFNode, Edge as RFEdge } from 'reactflow';
import type { BackendGraphNode, BackendGraphEdge, Certainty } from './graph-api';

export interface GraphNodeData {
  label: string;
  nodeType: string;
  filePath: string | null;
  certainty: Certainty;
  verified: boolean;
  provenanceSource: string;
  provenanceVersion: string;
}

export interface GraphEdgeData {
  edgeType: string;
  certainty: Certainty;
}

export type FlowNode = RFNode<GraphNodeData>;
export type FlowEdge = RFEdge<GraphEdgeData>;

const GRAPH_NODE_TYPE = 'graphNode';

/**
 * Why does this filter out malformed nodes/edges rather than throw?
 *
 * A single malformed record (an unexpected type this frontend doesn't
 * know how to render, or - defensively, even though the backend's own
 * invariants should prevent it - a dangling edge reference) shouldn't
 * take down the entire visualization. Filtering silently is the wrong
 * failure mode too, though - each dropped record is collected and
 * returned alongside the usable graph, so a caller can surface it
 * rather than the adapter silently hiding data loss.
 */
export interface AdaptedGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  containsEdges: FlowEdge[];
  droppedNodeCount: number;
  droppedEdgeCount: number;
}

export function adaptBackendNode(node: BackendGraphNode): FlowNode | null {
  if (!node.id || !node.type || typeof node.label !== 'string') return null;
  if (
    !node.provenance ||
    (node.provenance.certainty !== 'deterministic' && node.provenance.certainty !== 'inferred')
  ) {
    return null;
  }

  return {
    id: node.id,
    type: GRAPH_NODE_TYPE,
    position: { x: 0, y: 0 }, // filled in by the ELK layout pass, not here
    data: {
      label: node.label,
      nodeType: node.type,
      filePath: node.filePath,
      certainty: node.provenance.certainty,
      verified: node.provenance.verified,
      provenanceSource: node.provenance.source,
      provenanceVersion: node.provenance.sourceVersion,
    },
  };
}

export function adaptGraph(nodes: BackendGraphNode[], edges: BackendGraphEdge[]): AdaptedGraph {
  const flowNodes: FlowNode[] = [];
  let droppedNodeCount = 0;

  for (const node of nodes) {
    const adapted = adaptBackendNode(node);
    if (adapted) {
      flowNodes.push(adapted);
    } else {
      droppedNodeCount++;
    }
  }

  const knownNodeIds = new Set(flowNodes.map((n) => n.id));
  const flowEdges: FlowEdge[] = [];
  const containsEdges: FlowEdge[] = [];
  let droppedEdgeCount = 0;

  for (const edge of edges) {
    const isWellFormed =
      edge.id &&
      edge.source &&
      edge.target &&
      edge.type &&
      edge.provenance &&
      (edge.provenance.certainty === 'deterministic' || edge.provenance.certainty === 'inferred');

    if (!isWellFormed || !knownNodeIds.has(edge.source) || !knownNodeIds.has(edge.target)) {
      droppedEdgeCount++;
      continue;
    }

    const flowEdge: FlowEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: { edgeType: edge.type, certainty: edge.provenance.certainty },
    };

    flowEdges.push(flowEdge);
    if (edge.type === 'contains') {
      containsEdges.push(flowEdge);
    }
  }

  return { nodes: flowNodes, edges: flowEdges, containsEdges, droppedNodeCount, droppedEdgeCount };
}
