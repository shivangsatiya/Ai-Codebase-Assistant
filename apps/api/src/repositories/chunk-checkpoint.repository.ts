import { ChunkCheckpointModel, type ChunkCheckpointDocument } from '../models/chunk-checkpoint.model';

export interface ChunkCheckpointInput {
  repositoryId: string;
  jobId: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  chunkType: string;
  symbolName?: string;
  language: string;
}

export interface IChunkCheckpointRepository {
  insertMany(checkpoints: ChunkCheckpointInput[]): Promise<void>;
  findByRepositoryAndCommit(repositoryId: string, commitSha: string): Promise<ChunkCheckpointDocument[]>;
  deleteByRepositoryId(repositoryId: string): Promise<void>;
  deleteByJobId(jobId: string): Promise<void>;
}

export class MongoChunkCheckpointRepository implements IChunkCheckpointRepository {
  async insertMany(checkpoints: ChunkCheckpointInput[]): Promise<void> {
    if (checkpoints.length === 0) return;
    // No uniqueness constraint here, deliberately - unlike the real
    // Chunk collection's own unique index (which prevents duplicate
    // embeddings from ever landing twice), a checkpoint is a
    // short-lived, purely internal artifact that gets deleted wholesale
    // once real persistence succeeds (see deleteByJobId below). A
    // duplicate checkpoint row is harmless clutter, not a correctness
    // risk, so a plain insertMany is the right level of guarantee here.
    await ChunkCheckpointModel.insertMany(
      checkpoints.map((c) => ({
        repositoryId: c.repositoryId,
        jobId: c.jobId,
        commitSha: c.commitSha,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        contentHash: c.contentHash,
        chunkType: c.chunkType,
        symbolName: c.symbolName,
        language: c.language,
      })),
    );
  }

  async findByRepositoryAndCommit(repositoryId: string, commitSha: string): Promise<ChunkCheckpointDocument[]> {
    return ChunkCheckpointModel.find({ repositoryId, commitSha }).exec();
  }

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    await ChunkCheckpointModel.deleteMany({ repositoryId }).exec();
  }

  async deleteByJobId(jobId: string): Promise<void> {
    await ChunkCheckpointModel.deleteMany({ jobId }).exec();
  }
}
