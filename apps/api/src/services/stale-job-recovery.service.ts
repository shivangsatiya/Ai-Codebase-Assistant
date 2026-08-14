import type { IJobRepository } from '../repositories/repository.repository';
import { logger } from '../utils/logger';

/**
 * The one capability this sweep actually needs from
 * RepositoryImportService - kept as a small, dedicated interface
 * (rather than depending on the full concrete class) so this service
 * stays genuinely unit-testable without constructing every real
 * dependency RepositoryImportService itself requires.
 */
export interface IResumableImportService {
  resumeImport(repositoryId: string, jobId: string): Promise<void>;
}

/**
 * The actual recovery mechanism Milestone 4 Task 4 exists to build.
 * Confirmed directly (a real search, Task 4 design phase): no
 * heartbeat, lease, or staleness check existed anywhere in this
 * codebase before this - a crashed worker left its job permanently
 * stuck, with zero path to recovery. This closes that gap.
 *
 * Deliberately a plain, in-process class with no queue, no distributed
 * lock, and no external scheduler dependency - per the approved
 * design's own explicit instruction ("Do NOT introduce paid
 * infrastructure... a lightweight in-process scheduled sweep is
 * acceptable for the current deployment model").
 *
 * REAL, EXPLICITLY DOCUMENTED LIMITATION (per the approved design's own
 * instruction not to pretend otherwise): if this application ever runs
 * as more than one instance/replica (which it does not today, but
 * could in the future), EACH instance runs its own, fully independent
 * sweep on its own timer. This is still SAFE - never causes duplicate
 * processing or corrupted data - because claimStale()'s underlying
 * atomic findOneAndUpdate ensures only one instance's claim attempt
 * can ever actually succeed for a given job, no matter how many
 * instances are sweeping at once. The only real cost of multiple
 * instances is redundant claim attempts that simply find nothing left
 * to claim - a minor inefficiency, not a correctness risk. This is NOT
 * a distributed job scheduler, and should not be treated as
 * load-balancing recovery work evenly across instances - it is N
 * independent sweeps that happen to be safe to run concurrently.
 */
export class StaleJobRecoveryService {
  constructor(
    private readonly jobRepo: IJobRepository,
    private readonly importService: IResumableImportService,
    private readonly staleThresholdMs: number,
  ) {}

  /**
   * Runs one full sweep: repeatedly claims and resumes eligible jobs
   * until none remain. Each resume is deliberately NOT awaited before
   * moving on to check for the next stale job - resuming a job can
   * take as long as a full import (potentially minutes, dominated by
   * the same real embedding cost measured elsewhere in this project),
   * and this sweep should not block discovering and claiming other
   * stale jobs while one resume is still in flight. Every resume's own
   * outcome (success or failure) is still fully handled internally by
   * resumeImport() itself, including recording a real failure if it
   * doesn't succeed - this sweep's own job is purely claiming and
   * dispatching, not tracking each resume's individual result.
   */
  async runSweep(): Promise<number> {
    const staleBefore = new Date(Date.now() - this.staleThresholdMs);
    let claimedCount = 0;

    // Bounded by a real, sane ceiling rather than an unconditional
    // while(true) - defensive against an unexpected bug in claimStale
    // itself (e.g. a query that somehow always re-matches the same
    // document) turning into a genuine infinite loop in production.
    const maxClaimsPerSweep = 1000;

    for (let i = 0; i < maxClaimsPerSweep; i++) {
      const job = await this.jobRepo.claimStale(staleBefore);
      if (!job) break;

      claimedCount++;
      const repositoryId = job.repositoryId.toString();
      const jobId = job._id.toString();

      logger.info(
        { repositoryId, jobId, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, previousStage: job.stage },
        'Stale-job recovery: claimed a job for a resume attempt',
      );

      this.importService.resumeImport(repositoryId, jobId).catch((err) => {
        // resumeImport() already routes every real failure through
        // failImport() internally - reaching this catch means
        // something failed OUTSIDE that handling entirely (a genuinely
        // unexpected bug), which must still be logged rather than
        // silently swallowed, exactly like startImport()'s own
        // top-level .catch().
        logger.error({ err, repositoryId, jobId }, 'Unhandled error while resuming a claimed stale job');
      });
    }

    if (claimedCount > 0) {
      logger.info({ claimedCount }, 'Stale-job recovery sweep complete');
    }

    return claimedCount;
  }

  /**
   * Starts the recurring sweep on a plain setInterval - see the class
   * doc comment above for the real, honest multi-instance limitation
   * this implies. Returns the interval handle so callers (the app's
   * own bootstrap) can clear it during a graceful shutdown.
   */
  start(intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      this.runSweep().catch((err) => {
        logger.error({ err }, 'Stale-job recovery sweep failed unexpectedly');
      });
    }, intervalMs);
  }
}
