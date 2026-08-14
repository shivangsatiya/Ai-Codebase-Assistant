import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Why a SEPARATE model, not just an optional-embedding Chunk?
 *
 * Confirmed directly (chunk.model.ts): `embedding` is a required
 * field. Chunk cannot legally represent "content exists but hasn't
 * been embedded yet" - the field is required precisely because the
 * retrieval service (and $vectorSearch itself) depends on every real
 * Chunk document always having a genuine, usable vector. Weakening
 * that guarantee to accommodate a durability concern would be solving
 * one problem by creating a worse one.
 *
 * This collection exists for exactly one purpose: letting a resumed
 * job answer "what chunking work did I already finish?" without
 * re-cloning, re-walking, and re-chunking from scratch. It is never
 * read by retrieval, never exposed to any user-facing endpoint, and is
 * deleted once the real Chunk documents (with real embeddings) are
 * safely persisted - see repository-import.service.ts.
 */
export interface ChunkCheckpointDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  jobId: Types.ObjectId;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  chunkType: string;
  symbolName?: string;
  language: string;
  createdAt: Date;
}

const chunkCheckpointSchema = new Schema<ChunkCheckpointDocument>({
  repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
  jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
  commitSha: { type: String, required: true },
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true },
  endLine: { type: Number, required: true },
  content: { type: String, required: true },
  contentHash: { type: String, required: true },
  chunkType: { type: String, required: true },
  symbolName: { type: String, required: false },
  language: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

chunkCheckpointSchema.index({ repositoryId: 1, commitSha: 1 });
chunkCheckpointSchema.index({ jobId: 1 });

export const ChunkCheckpointModel = model<ChunkCheckpointDocument>('ChunkCheckpoint', chunkCheckpointSchema);
