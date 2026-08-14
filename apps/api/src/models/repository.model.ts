import { Schema, model, type Document, type Types } from 'mongoose';
import { normalizeGithubUrlForComparison } from '../utils/github-url-normalizer';

export type RepositoryStatus = 'queued' | 'cloning' | 'parsing' | 'embedding' | 'ready' | 'failed';

export interface RepositoryDocument extends Document {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  githubUrl: string;
  /**
   * Computed automatically from githubUrl via a pre-validate hook -
   * never set directly by any caller. Exists purely so duplicate-import
   * lookups can use a real, indexed, exact-match query instead of a
   * regex or an in-memory scan - see github-url-normalizer.ts for
   * exactly what "normalized" means and why it's needed at all.
   */
  githubUrlNormalized: string;
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
  githubUrlNormalized: { type: String, required: true },
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

repositorySchema.pre('validate', function (next) {
  this.githubUrlNormalized = normalizeGithubUrlForComparison(this.githubUrl);
  next();
});

repositorySchema.index({ ownerId: 1, createdAt: -1 });
// The real index the duplicate-import lookup depends on.
repositorySchema.index({ ownerId: 1, githubUrlNormalized: 1 });

export const RepositoryModel = model<RepositoryDocument>('Repository', repositorySchema);
