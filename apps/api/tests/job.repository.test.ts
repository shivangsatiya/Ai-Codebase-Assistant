import { MongoJobRepository } from '../src/repositories/repository.repository';
import { JobModel } from '../src/models/job.model';
import { Types } from 'mongoose';

describe('MongoJobRepository.claimStale', () => {
  const jobRepo = new MongoJobRepository();

  async function makeJob(
    overrides: Partial<{
      stage: string;
      updatedAt: Date;
      attemptCount: number;
      maxAttempts: number;
      failureCategory: string;
    }> = {},
  ) {
    return JobModel.create({
      repositoryId: new Types.ObjectId(),
      stage: overrides.stage ?? 'embedding',
      progress: 60,
      attemptCount: overrides.attemptCount ?? 1,
      maxAttempts: overrides.maxAttempts ?? 3,
      updatedAt: overrides.updatedAt ?? new Date(),
      failureCategory: overrides.failureCategory,
    });
  }

  const staleThreshold = new Date(Date.now() - 60_000);
  const genuinelyStale = new Date(Date.now() - 120_000);
  const genuinelyFresh = new Date();

  it('claims a genuinely stale, non-terminal job within its retry budget', async () => {
    const job = await makeJob({ stage: 'embedding', updatedAt: genuinelyStale, attemptCount: 1, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).not.toBeNull();
    expect(claimed!._id.toString()).toBe(job._id.toString());
  });

  it('increments attemptCount atomically as part of the same claim, not as a separate write', async () => {
    await makeJob({ stage: 'cloning', updatedAt: genuinelyStale, attemptCount: 1, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed!.attemptCount).toBe(2);
  });

  it('does NOT claim a fresh job, even if it is otherwise eligible in every other way', async () => {
    await makeJob({ stage: 'embedding', updatedAt: genuinelyFresh, attemptCount: 1, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it('does NOT claim a job that has already exhausted its retry budget - a real, honest terminal state, not silently retried forever', async () => {
    await makeJob({ stage: 'embedding', updatedAt: genuinelyStale, attemptCount: 3, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it('does NOT claim a job already in a terminal stage (complete), regardless of staleness', async () => {
    await makeJob({ stage: 'complete', updatedAt: genuinelyStale, attemptCount: 1, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it('does NOT claim a job already in a terminal stage (failed), regardless of staleness', async () => {
    await makeJob({ stage: 'failed', updatedAt: genuinelyStale, attemptCount: 1, maxAttempts: 3 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it(
    'REGRESSION: a real concurrent double-claim against the same stale job cannot both succeed - the exact race ' +
      'this atomic operation exists to prevent. Two calls fired together, only one may return the job.',
    async () => {
      await makeJob({ stage: 'embedding', updatedAt: genuinelyStale, attemptCount: 1, maxAttempts: 3 });

      const [first, second] = await Promise.all([jobRepo.claimStale(staleThreshold), jobRepo.claimStale(staleThreshold)]);

      const successes = [first, second].filter((result) => result !== null);
      expect(successes).toHaveLength(1);
    },
  );

  it('when multiple stale jobs exist, claims exactly one per call, oldest first', async () => {
    const older = await makeJob({ stage: 'cloning', updatedAt: new Date(Date.now() - 300_000), attemptCount: 1 });
    await makeJob({ stage: 'parsing', updatedAt: genuinelyStale, attemptCount: 1 });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed!._id.toString()).toBe(older._id.toString());
  });

  it(
    'REGRESSION (Milestone 4 Task 4.4): claims a FAILED job whose failure was classified retryable, once ' +
      'enough time has passed since it failed - a real, distinct scenario from a job merely stuck mid-flight',
    async () => {
      const job = await makeJob({
        stage: 'failed',
        failureCategory: 'retryable',
        updatedAt: genuinelyStale,
        attemptCount: 1,
        maxAttempts: 3,
      });

      const claimed = await jobRepo.claimStale(staleThreshold);

      expect(claimed).not.toBeNull();
      expect(claimed!._id.toString()).toBe(job._id.toString());
      expect(claimed!.attemptCount).toBe(2);
    },
  );

  it('does NOT claim a FAILED job classified permanent, even once it is stale and within its retry budget', async () => {
    await makeJob({
      stage: 'failed',
      failureCategory: 'permanent',
      updatedAt: genuinelyStale,
      attemptCount: 1,
      maxAttempts: 3,
    });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it('does NOT claim a FAILED-and-retryable job before enough time has passed since it failed (real backoff)', async () => {
    await makeJob({
      stage: 'failed',
      failureCategory: 'retryable',
      updatedAt: genuinelyFresh,
      attemptCount: 1,
      maxAttempts: 3,
    });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });

  it('does NOT claim a FAILED-and-retryable job that has already exhausted its retry budget', async () => {
    await makeJob({
      stage: 'failed',
      failureCategory: 'retryable',
      updatedAt: genuinelyStale,
      attemptCount: 3,
      maxAttempts: 3,
    });

    const claimed = await jobRepo.claimStale(staleThreshold);

    expect(claimed).toBeNull();
  });
});
