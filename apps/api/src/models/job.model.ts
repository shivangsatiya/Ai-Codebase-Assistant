import { Schema, model, type Document, type Types } from 'mongoose';

export type JobStage = 'cloning' | 'parsing' | 'embedding' | 'complete' | 'failed';
export type FailureCategory = 'retryable' | 'permanent';

export interface JobDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  stage: JobStage;
  progress: number; // 0-100
  error?: string;
  /**
   * Which category the most recent failure fell into - only ever set
   * alongside a real failure (see updateStage), never guessed or
   * defaulted. Read by the stale-job sweep (Task 4.4) to decide
   * whether a failed job is eligible for automatic retry at all, or
   * should stay failed regardless of attemptCount.
   */
  failureCategory?: FailureCategory;
  /**
   * How many times this job has actually been claimed for a real
   * processing attempt - starts at 1 for the original run (set by
   * createForRepository), incremented only by a real, atomic claim
   * (see claimStale). Never resets. This is a durable fact about how
   * many attempts have genuinely happened, not a synthetic counter.
   */
  attemptCount: number;
  /**
   * The bound on attemptCount - a job at or beyond this count is never
   * eligible for further automatic retry, regardless of how stale it
   * becomes. A real, per-job value (not just a global constant) so a
   * future caller could reasonably override it per job if ever needed,
   * without a schema change.
   */
  maxAttempts: number;
  updatedAt: Date;
}

const jobSchema = new Schema<JobDocument>({
  repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
  stage: {
    type: String,
    enum: ['cloning', 'parsing', 'embedding', 'complete', 'failed'],
    default: 'cloning',
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  error: { type: String, required: false },
  failureCategory: { type: String, enum: ['retryable', 'permanent'], required: false },
  attemptCount: { type: Number, default: 1, min: 1 },
  maxAttempts: { type: Number, default: 3, min: 1 },
  updatedAt: { type: Date, default: () => new Date() },
});

jobSchema.index({ repositoryId: 1 });
// Supports the stale-job sweep's real query pattern (Task 4.4): find
// non-terminal jobs, staler than a threshold, still within their retry
// budget - all three conditions together, not a full collection scan.
jobSchema.index({ stage: 1, updatedAt: 1, attemptCount: 1 });

export const JobModel = model<JobDocument>('Job', jobSchema);
