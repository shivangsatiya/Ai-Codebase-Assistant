# Milestone 4 Task 4 — Staff Engineer Review

Required by the original Task 4 spec before this task can be declared complete. Answered honestly against everything actually built and verified across substeps 4.1-4.6, not as a formality.

## Correctness

**Can a crash corrupt state?** No transaction wraps the pipeline's sequence of writes - a crash between two writes can leave an intermediate state (e.g. chunks inserted but the job still shows `'embedding'`). This is real, but recoverable, not corrupting: the stale-job sweep eventually claims it, and `insertManyIdempotent`'s unique index makes a resume safe against re-inserting the same chunks.

**Can a repository become falsely READY?** No - `'ready'` is only ever set after chunk persistence genuinely succeeds, confirmed directly by the Task 4.6 crash-simulation tests (clone, chunking, embedding, and persistence failures were each explicitly verified to never reach `'ready'`). The one deliberate exception: graph generation failure is non-fatal by design, so a repository can be `'ready'` with no graph - a documented trade-off, not a false-ready bug.

**Can duplicate data be created?** No for chunks (real unique index), no for graphs (`findByCommitSha` pre-check), no for repositories as of Task 4.2 (duplicate-import protection), no for jobs (a resume reuses the existing `Job` document, never creates a new one).

## Concurrency

**Can two workers process the same job?** No - `claimStale`'s atomic `findOneAndUpdate` guarantees only one caller's claim can succeed, verified directly with a real concurrent-double-claim regression test in Task 4.1.

**Can stale recovery race with a live worker?** A real, honestly-acknowledged limitation, not something to overclaim safety on: the stale threshold (10 minutes, a generous multiple of the worst real measured stage duration - 156s for embedding, Task 1's own finding) assumes no single stage legitimately runs longer than that. If one genuinely did, the sweep could claim a job that's still actively, correctly being processed, resulting in two concurrent pipeline runs for the same repository. This wouldn't corrupt data (the same idempotency guarantees apply), but it would be wasteful, duplicate work. A true fix needs a genuine heartbeat mechanism updating `updatedAt` *during* a long stage, not just at stage transitions - real, nontrivial complexity the design's own explicit instruction ("prefer the simplest correct mechanism... do not create a complicated lease system unless required") argues against building for a portfolio-scale project, given the threshold's existing generous margin. Documented here as a known, accepted limitation rather than silently left undiscovered.

## Reliability

**Can a job remain permanently stuck?** No, assuming the sweep runs - any stale job is eventually claimed within its retry budget, and once that budget is exhausted, it lands in a real, visible `'failed'` state rather than an invisible hang.

**Are retry limits safe?** Yes - bounded at `maxAttempts` (default 3), preventing infinite retry loops.

## Data lifecycle

**Can deleted repositories leave graphs/chunks/jobs behind?** No, as of Task 4.5 - the cascade now covers chats, messages, jobs, chunks, chunk checkpoints, and knowledge graphs, verified with real tests including one against an actual database confirming cross-repository isolation.

## Security

**Can one user manipulate another user's job?** No new surface was introduced - `resumeImport(repositoryId, jobId)` is only ever called internally by the sweep itself, never exposed through any user-facing route. The existing, pre-Task-4 ownership checks on the repository routes are unchanged.

## Operations

**Can this run without paid infrastructure?** Yes - a plain `setInterval`, no queue, no new deployment dependency.

**What happens after a deployment restart?** The sweep restarts fresh. Any job that was stuck specifically because of the restart itself gets picked up by the next sweep tick once it crosses the stale threshold - precisely the scenario this whole task exists to handle.

## Maintainability

**Is the state machine understandable?** Yes - this design deliberately reused the existing, simple stage enum rather than inventing new states without genuine durable boundaries behind them (an explicit decision made during the design phase).

**Are responsibilities separated?** Yes - `RepositoryImportService` owns the pipeline itself, `StaleJobRecoveryService` owns discovering and dispatching recovery, the repository layer owns persistence. No class grew to cover unrelated concerns.

**Are retry rules explicit?** Yes - `classifyImportFailure` is a separate, named, independently-tested function, not inline judgment calls scattered through the pipeline.

## Complexity

**Did we add more infrastructure than necessary?** No new infrastructure at all - new MongoDB fields and one new small collection (`ChunkCheckpoint`), plus in-process logic. No queue, no Redis dependency introduced for this, no new deployment target.

---

## Genuine issues found during this review and their resolution

1. **Chunking, embedding, and chunk-persistence failures had zero test coverage** before Task 4.6 - only clone failures and graph-generation failures (already non-fatal) were previously exercised. Closed with dedicated crash-simulation tests for each, verifying no false-ready state, no stuck job, and no partial chunk data in every case.
2. **The stale-threshold race with a genuinely long-running live worker** (documented above) - a real, accepted limitation given this project's scale and the design's own preference for the simplest correct mechanism, not silently overlooked.

No other genuine issues were found during this review that the existing Task 4.1-4.5 work hadn't already addressed.
