export type Certainty = 'deterministic' | 'inferred';

export interface Provenance {
  source: string; // e.g. 'DeterministicExtractor', 'CycleDetector'
  sourceVersion: string;
  certainty: Certainty;
  verified: boolean;
}

/**
 * What an extractor produces - raw, unvalidated, no final identity yet.
 * Extractors report facts; only the Repository Intelligence Pipeline is
 * permitted to turn a fact into an identified, provenanced, persisted
 * graph member. See node-identity.ts for how idComponents become a
 * final, stable id.
 */
export interface CandidateNode {
  type: string;
  idComponents: string[];
  label: string;
  filePath: string | null;
  metadata: Record<string, unknown>;
  source: string;
  sourceVersion: string;
  certainty: Certainty;
}

export interface CandidateEdge {
  type: string;
  sourceType: string;
  sourceIdComponents: string[];
  targetType: string;
  targetIdComponents: string[];
  metadata: Record<string, unknown>;
  source: string;
  sourceVersion: string;
  certainty: Certainty;
}

/** What the pipeline produces once a candidate has been approved. */
export interface GraphNode {
  id: string;
  type: string;
  label: string;
  filePath: string | null;
  metadata: Record<string, unknown>;
  provenance: Provenance;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  metadata: Record<string, unknown>;
  provenance: Provenance;
}

export type PipelineResultStatus = 'ready' | 'failed' | 'already_exists';

export interface PipelineResult {
  status: PipelineResultStatus;
  repositoryId: string;
  commitSha: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  failureReasons?: string[];
}
