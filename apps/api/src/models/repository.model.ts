import { Schema, model, type Document, type Types } from 'mongoose';

export type RepositoryStatus = 'queued' | 'cloning' | 'parsing' | 'embedding' | 'ready' | 'failed';

export interface RepositoryDocument extends Document {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  githubUrl: string;
  defaultBranch?: string;
  commitSha?: string;
  isPrivate: boolean;
  status: RepositoryStatus;
  fileCount?: number;
  errorMessage?: string;
  createdAt: Date;
}

const repositorySchema = new Schema<RepositoryDocument>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  githubUrl: { type: String, required: true, trim: true },
  defaultBranch: { type: String, required: false },
  commitSha: { type: String, required: false },
  isPrivate: { type: Boolean, required: true, default: false },
  status: {
    type: String,
    enum: ['queued', 'cloning', 'parsing', 'embedding', 'ready', 'failed'],
    default: 'queued',
  },
  fileCount: { type: Number, required: false },
  errorMessage: { type: String, required: false },
  createdAt: { type: Date, default: () => new Date() },
});

repositorySchema.index({ ownerId: 1, createdAt: -1 });

export const RepositoryModel = model<RepositoryDocument>('Repository', repositorySchema);
