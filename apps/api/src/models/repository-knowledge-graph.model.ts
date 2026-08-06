import { Schema, model, type Document, type Types } from 'mongoose';

export type GraphStatus = 'generating' | 'ready' | 'failed';

export interface ProvenanceSubdoc {
  source: string;
  sourceVersion: string;
  certainty: 'deterministic' | 'inferred';
  verified: boolean;
}

export interface GraphNodeSubdoc {
  id: string;
  type: string;
  label: string;
  filePath: string | null;
  metadata: Record<string, unknown>;
  provenance: ProvenanceSubdoc;
}

export interface GraphEdgeSubdoc {
  id: string;
  source: string;
  target: string;
  type: string;
  metadata: Record<string, unknown>;
  provenance: ProvenanceSubdoc;
}

export interface RepositoryKnowledgeGraphDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  commitSha: string;
  status: GraphStatus;
  nodes: GraphNodeSubdoc[];
  edges: GraphEdgeSubdoc[];
  failureReasons: string[];
  createdAt: Date;
}

const provenanceSchema = new Schema<ProvenanceSubdoc>(
  {
    source: { type: String, required: true },
    sourceVersion: { type: String, required: true },
    // Open string at the database level, not a hard enum - same
    // extensibility mechanism as node.type/edge.type below (and the
    // same pattern this project already uses for chunkType): adding a
    // future certainty-adjacent concept is a code change, never a
    // migration. The actual currently-supported values are enforced by
    // graph-invariants.ts, not by the schema.
    certainty: { type: String, required: true },
    verified: { type: Boolean, required: true },
  },
  { _id: false },
);

const graphNodeSchema = new Schema<GraphNodeSubdoc>(
  {
    id: { type: String, required: true },
    // Open string, no enum constraint - the concrete mechanism behind
    // "adding a new node type is a code change, never a database
    // migration."
    type: { type: String, required: true },
    label: { type: String, required: true },
    filePath: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    provenance: { type: provenanceSchema, required: true },
  },
  { _id: false },
);

const graphEdgeSchema = new Schema<GraphEdgeSubdoc>(
  {
    id: { type: String, required: true },
    // Field names 'source'/'target', not 'from'/'to' - deliberately
    // matching what graph visualization libraries commonly expect
    // directly (Milestone 3b).
    source: { type: String, required: true },
    target: { type: String, required: true },
    type: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    provenance: { type: provenanceSchema, required: true },
  },
  { _id: false },
);

const repositoryKnowledgeGraphSchema = new Schema<RepositoryKnowledgeGraphDocument>({
  repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
  commitSha: { type: String, required: true },
  status: { type: String, enum: ['generating', 'ready', 'failed'], required: true },
  nodes: { type: [graphNodeSchema], default: [] },
  edges: { type: [graphEdgeSchema], default: [] },
  failureReasons: { type: [String], default: [] },
  createdAt: { type: Date, default: () => new Date() },
});

/**
 * Two indexes, one per real access pattern:
 * - (repositoryId, commitSha) unique - the idempotency guarantee itself
 *   (Version Management can never persist two documents for the same
 *   commit), and the lookup this pipeline's own idempotency check uses.
 * - (repositoryId, createdAt) - "get the latest graph for a repository,"
 *   the exact same index shape already proven for the repository-list
 *   query in Milestone 2, Task 5.
 */
repositoryKnowledgeGraphSchema.index({ repositoryId: 1, commitSha: 1 }, { unique: true });
repositoryKnowledgeGraphSchema.index({ repositoryId: 1, createdAt: -1 });

export const RepositoryKnowledgeGraphModel = model<RepositoryKnowledgeGraphDocument>(
  'RepositoryKnowledgeGraph',
  repositoryKnowledgeGraphSchema,
);
