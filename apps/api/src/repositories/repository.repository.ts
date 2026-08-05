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
  findByOwnerId(ownerId: string): Promise<RepositoryDocument[]>;
  updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage'>>,
  ): Promise<void>;
  deleteById(id: string): Promise<void>;
}

export interface IJobRepository {
  createForRepository(repositoryId: string): Promise<JobDocument>;
  findByRepositoryId(repositoryId: string): Promise<JobDocument | null>;
  updateStage(id: string, stage: JobStage, progress: number, error?: string): Promise<void>;
  deleteByRepositoryId(repositoryId: string): Promise<void>;
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

  /**
   * Sorted newest-first - the most natural default for "list my
   * repositories" with no pagination yet (a reasonable omission at
   * portfolio scale; a natural addition if this list ever grew large
   * enough to need it, not something this task's scope requires today).
   */
  async findByOwnerId(ownerId: string): Promise<RepositoryDocument[]> {
    return RepositoryModel.find({ ownerId }).sort({ createdAt: -1 }).exec();
  }

  async updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage'>>,
  ): Promise<void> {
    await RepositoryModel.findByIdAndUpdate(id, { status, ...extra }).exec();
  }

  async deleteById(id: string): Promise<void> {
    await RepositoryModel.deleteOne({ _id: id }).exec();
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

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    await JobModel.deleteMany({ repositoryId }).exec();
  }
}
