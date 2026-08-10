import { apiRequest } from './api-client';

export type GraphStatus = 'generating' | 'ready' | 'failed' | 'not_generated';
export type Certainty = 'deterministic' | 'inferred';

export interface Provenance {
  source: string;
  sourceVersion: string;
  certainty: Certainty;
  verified: boolean;
}

/** Matches GraphNodeSubdoc exactly - metadata is a genuinely open bag, not a fixed shape. */
export interface BackendGraphNode {
  id: string;
  type: string;
  label: string;
  filePath: string | null;
  metadata: Record<string, unknown>;
  provenance: Provenance;
}

export interface BackendGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  metadata: Record<string, unknown>;
  provenance: Provenance;
}

/** Matches GET /:id/graph exactly, including the real 'not_generated' case. */
export interface GraphResponse {
  status: GraphStatus;
  commitSha?: string;
  nodes: BackendGraphNode[];
  edges: BackendGraphEdge[];
}

export interface CycleDetectionResult {
  cycles: string[][];
  cycleCount: number;
}

export async function getRepositoryGraph(repositoryId: string): Promise<GraphResponse> {
  return apiRequest<GraphResponse>(`/api/repositories/${repositoryId}/graph`);
}

/**
 * A real, separate backend call to the already-existing cycle-detection
 * algorithm endpoint - not a frontend re-implementation. The backend
 * design explicitly permits displaying backend-provided intelligence
 * while forbidding the frontend from computing it itself; this is that
 * exact boundary, not a loophole around it.
 */
/** Matches DependencyAnalysisResult exactly - used to format pure_graph JSON answers returned from /graph/ask. */
export interface DependencyAnalysisResult {
  mode: string;
  nodeIds: string[];
  path?: string[] | null;
}

export async function getCycles(repositoryId: string): Promise<CycleDetectionResult> {
  const result = await apiRequest<{ algorithm: string; result: CycleDetectionResult }>(
    `/api/repositories/${repositoryId}/graph/analysis/cycle-detection`,
  );
  return result.result;
}
