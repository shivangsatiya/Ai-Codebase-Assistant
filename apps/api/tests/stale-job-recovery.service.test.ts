import { StaleJobRecoveryService, type IResumableImportService } from '../src/services/stale-job-recovery.service';
import type { IJobRepository } from '../src/repositories/repository.repository';
import type { JobDocument } from '../src/models/job.model';
import { Types } from 'mongoose';
import { logger } from '../src/utils/logger';

function makeJobDoc(id: string, repositoryId: string, overrides: Partial<JobDocument> = {}): JobDocument {
  return {
    _id: new Types.ObjectId(id),
    repositoryId: new Types.ObjectId(repositoryId),
    stage: 'embedding',
    progress: 60,
    attemptCount: 2,
    maxAttempts: 3,
    updatedAt: new Date(),
    ...overrides,
  } as unknown as JobDocument;
}

class FakeJobRepositoryForSweep implements Partial<IJobRepository> {
  public claimStaleCallCount = 0;
  private queue: (JobDocument | null)[];

  constructor(queue: (JobDocument | null)[]) {
    this.queue = [...queue];
  }

  async claimStale(_staleBefore: Date): Promise<JobDocument | null> {
    this.claimStaleCallCount++;
    return this.queue.length > 0 ? this.queue.shift()! : null;
  }
}

class FakeResumableImportService implements IResumableImportService {
  public resumedCalls: Array<{ repositoryId: string; jobId: string }> = [];
  public shouldRejectFor: Set<string> = new Set();

  async resumeImport(repositoryId: string, jobId: string): Promise<void> {
    this.resumedCalls.push({ repositoryId, jobId });
    if (this.shouldRejectFor.has(jobId)) {
      throw new Error('Simulated unexpected rejection from resumeImport');
    }
  }
}

describe('StaleJobRecoveryService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 0 and calls resumeImport zero times when nothing is stale', async () => {
    const jobRepo = new FakeJobRepositoryForSweep([null]);
    const importService = new FakeResumableImportService();
    const service = new StaleJobRecoveryService(jobRepo as unknown as IJobRepository, importService, 600_000);

    const claimedCount = await service.runSweep();

    expect(claimedCount).toBe(0);
    expect(importService.resumedCalls).toHaveLength(0);
  });

  it('claims and resumes every eligible job in one sweep, not just the first one', async () => {
    const jobA = makeJobDoc('aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb');
    const jobB = makeJobDoc('cccccccccccccccccccccccc', 'dddddddddddddddddddddddd');
    const jobRepo = new FakeJobRepositoryForSweep([jobA, jobB, null]);
    const importService = new FakeResumableImportService();
    const service = new StaleJobRecoveryService(jobRepo as unknown as IJobRepository, importService, 600_000);

    const claimedCount = await service.runSweep();
    await new Promise((resolve) => setImmediate(resolve));

    expect(claimedCount).toBe(2);
    expect(importService.resumedCalls).toEqual([
      { repositoryId: jobA.repositoryId.toString(), jobId: jobA._id.toString() },
      { repositoryId: jobB.repositoryId.toString(), jobId: jobB._id.toString() },
    ]);
  });

  it(
    'REGRESSION: one job whose resumeImport unexpectedly rejects does not stop the sweep from claiming and ' +
      'resuming the other eligible jobs - one bad job must not silently block every other stuck job forever',
    async () => {
      const jobA = makeJobDoc('aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb');
      const jobB = makeJobDoc('cccccccccccccccccccccccc', 'dddddddddddddddddddddddd');
      const jobRepo = new FakeJobRepositoryForSweep([jobA, jobB, null]);
      const importService = new FakeResumableImportService();
      importService.shouldRejectFor.add(jobA._id.toString());
      jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const service = new StaleJobRecoveryService(jobRepo as unknown as IJobRepository, importService, 600_000);

      const claimedCount = await service.runSweep();
      await new Promise((resolve) => setImmediate(resolve));

      expect(claimedCount).toBe(2);
      expect(importService.resumedCalls.map((c) => c.jobId)).toEqual([jobA._id.toString(), jobB._id.toString()]);
    },
  );

  it('passes a staleBefore threshold to claimStale derived from the configured threshold, not a hardcoded value', async () => {
    const jobRepo = new FakeJobRepositoryForSweep([null]);
    const claimStaleSpy = jest.spyOn(jobRepo, 'claimStale');
    const importService = new FakeResumableImportService();
    const thresholdMs = 123_456;
    const service = new StaleJobRecoveryService(jobRepo as unknown as IJobRepository, importService, thresholdMs);

    const before = Date.now();
    await service.runSweep();
    const after = Date.now();

    const calledWith = claimStaleSpy.mock.calls[0]?.[0] as Date;
    expect(calledWith).toBeDefined();
    expect(calledWith.getTime()).toBeGreaterThanOrEqual(before - thresholdMs - 1000);
    expect(calledWith.getTime()).toBeLessThanOrEqual(after - thresholdMs + 1000);
  });
});
