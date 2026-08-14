import { RepositoryModel, type RepositoryDocument, type RepositoryStatus } from '../models/repository.model';
import { JobModel, type JobDocument, type JobStage, type FailureCategory } from '../models/job.model';
import { normalizeGithubUrlForComparison } from '../utils/github-url-normalizer';

export interface CreateRepositoryInput {
  ownerId: string;
  githubUrl: string;
  isPrivate: boolean;
}

export interface IRepositoryRepository {
  create(input: CreateRepositoryInput): Promise<RepositoryDocument>;
  findById(id: string): Promise<RepositoryDocument | null>;
  findByOwnerId(ownerId: string): Promise<RepositoryDocument[]>;
  /**
   * The real lookup duplicate-import protection depends on - finds an
   * existing repository for this exact owner+URL pair, if one exists,
   * so startImport can decide whether to create a new document at all.
   */
  findByOwnerIdAndGithubUrl(ownerId: string, githubUrl: string): Promise<RepositoryDocument | null>;
  updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage' | 'isPrivate'>>,
  ): Promise<void>;
  deleteById(id: string): Promise<void>;
}

export interface IJobRepository {
  createForRepository(repositoryId: string): Promise<JobDocument>;
  findByRepositoryId(repositoryId: string): Promise<JobDocument | null>;
  updateStage(id: string, stage: JobStage, progress: number, error?: string, failureCategory?: FailureCategory): Promise<void>;
  deleteByRepositoryId(repositoryId: string): Promise<void>;
  /**
   * Atomically finds ONE job eligible for a recovery attempt, and
   * claims it by incrementing attemptCount and refreshing updatedAt in
   * the SAME atomic operation. Returns the claimed job, or null if
   * none qualified. Covers TWO real, distinct scenarios under one
   * mechanism, since both reduce to the same underlying question - "is
   * this job worth trying again?":
   *
   * 1. Genuinely STUCK: the job is in a non-terminal stage (cloning,
   *    parsing, embedding) and hasn't been updated since `staleBefore`
   *    - the worker that was processing it almost certainly crashed or
   *    was killed before it could reach a terminal state at all.
   *
   * 2. FAILED but classified retryable: the job already reached
   *    'failed' via a real, caught exception that
   *    classifyImportFailure() judged transient (see
   *    import-failure-classifier.ts) - a network blip, a temporary DB
   *    hiccup - rather than something retrying can't fix.
   *
   * Both require `attemptCount < maxAttempts` - a job that's already
   * exhausted its retry budget is never claimed again by either path,
   * regardless of staleness. A job whose stage is still 'failed' at
   * the moment it's claimed here is not explicitly reset to a
   * non-terminal stage - runImportPipeline's own very first step
   * (marking 'cloning') does that naturally as soon as the resumed
   * attempt actually begins.
   *
   * Why findOneAndUpdate specifically, not a separate find-then-update?
   *
   * A separate find, then a separate update, has a real race: two
   * concurrent sweep invocations (or a sweep racing a still-running
   * worker whose process merely paused, not crashed) could both read
   * the same stale job before either writes anything, and both would
   * believe they'd claimed it. findOneAndUpdate is a single atomic
   * document operation in MongoDB - the query condition is evaluated
   * and the update applied as one indivisible step, so a second
   * concurrent call's query simply no longer matches once the first
   * call's update has landed (updatedAt is now "fresh" from that first
   * call's own perspective, well before it's re-read by a caller who
   * lost the race).
   */
  claimStale(staleBefore: Date): Promise<JobDocument | null>;
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

  async findByOwnerIdAndGithubUrl(ownerId: string, githubUrl: string): Promise<RepositoryDocument | null> {
    return RepositoryModel.findOne({
      ownerId,
      githubUrlNormalized: normalizeGithubUrlForComparison(githubUrl),
    }).exec();
  }

  async updateStatus(
    id: string,
    status: RepositoryStatus,
    extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage' | 'isPrivate'>>,
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

  async updateStage(
    id: string,
    stage: JobStage,
    progress: number,
    error?: string,
    failureCategory?: FailureCategory,
  ): Promise<void> {
    await JobModel.findByIdAndUpdate(id, { stage, progress, error, failureCategory, updatedAt: new Date() }).exec();
  }

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    await JobModel.deleteMany({ repositoryId }).exec();
  }

  async claimStale(staleBefore: Date): Promise<JobDocument | null> {
    return JobModel.findOneAndUpdate(
      {
        $or: [
          { stage: { $in: ['cloning', 'parsing', 'embedding'] } },
          { stage: 'failed', failureCategory: 'retryable' },
        ],
        updatedAt: { $lt: staleBefore },
        $expr: { $lt: ['$attemptCount', '$maxAttempts'] },
      },
      { $inc: { attemptCount: 1 }, $set: { updatedAt: new Date() } },
      { new: true, sort: { updatedAt: 1 } },
    ).exec();
  }
}
