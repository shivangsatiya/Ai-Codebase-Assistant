import { Schema, model, type Document, type Types } from 'mongoose';

export type JobStage = 'cloning' | 'parsing' | 'embedding' | 'complete' | 'failed';

export interface JobDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  stage: JobStage;
  progress: number; // 0-100
  error?: string;
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
  updatedAt: { type: Date, default: () => new Date() },
});

jobSchema.index({ repositoryId: 1 });

export const JobModel = model<JobDocument>('Job', jobSchema);
