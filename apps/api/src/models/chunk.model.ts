import { Schema, model, type Document, type Types } from 'mongoose';

export interface ChunkDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
  language: string;
  symbolName?: string;
  chunkType: string;
  contentHash: string;
  createdAt: Date;
}

const chunkSchema = new Schema<ChunkDocument>({
  repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
  commitSha: { type: String, required: true },
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true },
  endLine: { type: Number, required: true },
  content: { type: String, required: true },
  embedding: { type: [Number], required: true },
  language: { type: String, required: true },
  symbolName: { type: String, required: false },
  chunkType: { type: String, required: true },
  contentHash: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

/**
 * This is the actual mechanism behind the design doc's "re-importing the
 * same repo/commit shouldn't duplicate embeddings" requirement. A unique
 * compound index means a second import of the same commit, with
 * byte-identical chunk content, fails the insert at the database layer
 * with a duplicate-key error rather than silently doubling every chunk
 * (and re-computing every embedding for no reason) - the repository
 * layer (see chunk.repository.ts) treats that specific error as
 * "already indexed, skip" rather than a real failure.
 */
chunkSchema.index({ repositoryId: 1, commitSha: 1, contentHash: 1 }, { unique: true });

// Supports the retrieval query pattern used by chat later in Milestone 1:
// $vectorSearch filtered to a specific repositoryId.
chunkSchema.index({ repositoryId: 1 });

export const ChunkModel = model<ChunkDocument>('Chunk', chunkSchema);
