import { RepositoryModel, type RepositoryDocument, type RepositoryStatus } from '../models/repository.model';
import { JobModel, type JobDocument, type JobStage } from '../models/job.model';

export interface CreateRepositoryInput {
  ownerId: string;
  githubUrl: string;
  isPrivate: boolean;
}

export interface IRepositoryRepository {
  create(input: CreateRepositoryInput): Promise<RepositoryDocument>;
  findById(id: string): Promise<RepositoryDocument | null>;
  updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage'>>,
  ): Promise<void>;
}

export interface IJobRepository {
  createForRepository(repositoryId: string): Promise<JobDocument>;
  findByRepositoryId(repositoryId: string): Promise<JobDocument | null>;
  updateStage(id: string, stage: JobStage, progress: number, error?: string): Promise<void>;
}

export class MongoRepositoryRepository implements IRepositoryRepository {
  async create(input: CreateRepositoryInput): Promise<RepositoryDocument> {
    return RepositoryModel.create({
      ownerId: input.ownerId,
      githubUrl: input.githubUrl,
      isPrivate: input.isPrivate,
      status: 'queued',
    });
  }

  async findById(id: string): Promise<RepositoryDocument | null> {
    return RepositoryModel.findById(id).exec();
  }

  async updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage'>>,
  ): Promise<void> {
    await RepositoryModel.findByIdAndUpdate(id, { status, ...extra }).exec();
  }
}

export class MongoJobRepository implements IJobRepository {
  async createForRepository(repositoryId: string): Promise<JobDocument> {
    return JobModel.create({ repositoryId, stage: 'cloning', progress: 0 });
  }

  async findByRepositoryId(repositoryId: string): Promise<JobDocument | null> {
    return JobModel.findOne({ repositoryId }).sort({ updatedAt: -1 }).exec();
  }

  async updateStage(id: string, stage: JobStage, progress: number, error?: string): Promise<void> {
    await JobModel.findByIdAndUpdate(id, { stage, progress, error, updatedAt: new Date() }).exec();
  }
}
