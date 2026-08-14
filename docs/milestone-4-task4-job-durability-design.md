# Milestone 4 Task 4 — Repository Import Job Durability (Design)

**Status: design phase only. No implementation code accompanies this document.**

**Methodology note**: every claim below was verified directly against the current source tree while writing this document - file and line references are given throughout, not recalled from earlier sessions' summaries. Where something is a genuine proposal rather than existing behavior, it is labeled explicitly as **PROPOSED**.

---

## 0. Executive Summary

The current pipeline is a single, long-running, un-awaited async function (`RepositoryImportService.runImportPipeline`) with almost no durable checkpointing. Two Mongo documents (`Repository`, `Job`) are updated at coarse stage boundaries, but the actual work of each stage - cloning, walking, chunking, embedding - happens entirely in local variables in one function's call stack. If the Node process dies at any point before the single chunk-insert call near the end, all of that work is silently lost, and the `Job`/`Repository` documents are left permanently frozen at whatever stage they last reached, with no mechanism anywhere in the codebase to detect or resume this.

The good news, confirmed directly rather than assumed: the two most expensive, failure-prone operations - chunk/embedding persistence (`insertManyIdempotent`, verified idempotent via a real unique compound index) and knowledge graph generation (verified idempotent via a real `findByCommitSha` pre-check) - are already safely retryable. The gap is almost entirely in the orchestration layer around them, not in the core write operations themselves.

---

## 1. Current Pipeline Analysis

Traced directly from `repository-import.service.ts`, `job.model.ts`, `repository.model.ts`, `chunk.repository.ts`, and `repository-intelligence-pipeline.ts`.

| Stage | Current behavior | Durable state | Retryable | Idempotent | Resume-safe |
|---|---|---|---|---|---|
| Repository doc creation | `repositoryRepo.create()` - one Mongo insert, `status: 'queued'` (schema default) | Yes, immediately | N/A (one-shot) | N/A | N/A |
| Job doc creation | `jobRepo.createForRepository()` - one Mongo insert, `stage: 'cloning'`, `progress: 0` | Yes, immediately | N/A | N/A | N/A |
| Pipeline dispatch | `runImportPipeline(...)` called without `await` - a fire-and-forget in-process async call (`repository-import.service.ts:86-95`) | No - exists only as an in-memory Promise/call stack | No - nothing re-triggers it | N/A | No |
| Clone | `gitCloner.clone()` - real `git clone` to a local temp directory | Only `status: 'cloning'` marker; the clone itself is a local filesystem side effect, not tracked in Mongo | Yes, if re-run from scratch | Yes trivially (a fresh clone each time) | No - nothing records that a clone happened or where |
| Status -> parsing | `repositoryRepo.updateStatus(..., 'parsing', {defaultBranch, commitSha})` | Yes - `commitSha` is durably known from this point forward | - | - | - |
| Walk + Chunk | `walkRepoFiles()` then a per-file loop calling `chunkingService.chunkFile()` - pure in-memory, produces `allChunks` array | None at all | Yes, if re-run from a fresh clone | Yes (pure function of file content) | No - result lives only in a local variable |
| Status -> embedding | `repositoryRepo.updateStatus(..., 'embedding')` | Yes (status marker only) | - | - | - |
| Embed | `embeddingProvider.embedBatch()` - the single most expensive real-time step measured in this project (156s for 56 files, Milestone 4 Task 1 finding) | None - result lives only in a local `embeddings` array | Yes, if re-run | Yes (pure function of chunk content) | No |
| Persist chunks+embeddings | `chunkRepo.insertManyIdempotent()` - the first point any of clone/walk/chunk/embed durably lands in Mongo | Yes, in `Chunk` documents | Yes | Yes, verified - unique index on `{repositoryId, commitSha, contentHash}` (`chunk.model.ts:44`), duplicate-key errors caught and treated as skips | Partial - chunks are durable, but nothing upstream is |
| Graph generation | `knowledgeGraphGenerationService.generateGraph()`, wrapped in its own try/catch that never fails the import (`repository-import.service.ts:250-279`) | Yes - persisted via `RepositoryIntelligencePipeline`'s own governed write | Yes | Yes, verified - `findByCommitSha(repositoryId, commitSha)` pre-check returns `already_exists` rather than redoing work (`repository-intelligence-pipeline.ts:34-36`) | Yes, for the same `repositoryId` |
| Status -> ready / job -> complete | `repositoryRepo.updateStatus(..., 'ready')` + `jobRepo.updateStage(..., 'complete', 100)` | Yes | - | - | - |
| Cleanup | `cloned.cleanup()` in a `finally` block at the outer try level - runs on both success and failure | Deletes the local clone directory | - | - | Once this runs, resuming clone/walk/chunk from the same local files is no longer possible; a resume would need a fresh clone |
| Failure path | `failImport()` sets `status: 'failed'` + `stage: 'failed'` with an error message | Yes | Manual only - nothing auto-retries | - | - |

The single most important fact this table establishes: everything from "clone starts" through "chunks are inserted" - which includes the slowest step in the whole pipeline (embedding) - has zero durable checkpointing. A crash anywhere in that window loses all of it, with the `Job` document frozen at `'cloning'`, `'parsing'`, or `'embedding'` forever.

---

## 2. Failure Analysis

| Failure | What currently happens | Data left behind | Safely retryable? | Duplicate-data risk | Could a repo appear "ready" incorrectly? |
|---|---|---|---|---|---|
| Process crash / restart during clone-through-embed | In-memory work vanishes. `Job`/`Repository` frozen at their last-written stage. Local clone directory is orphaned on disk (never cleaned up, since `finally` never ran) | An orphaned temp directory; a `Repository` doc stuck at a non-terminal status forever | No mechanism exists to retry at all today | Low (nothing was written to Mongo yet in this window) | No - it stays visibly stuck, not falsely "ready" |
| Crash during/after chunk insert, before graph generation | Chunks are durably persisted (safe). Graph generation never ran. Cleanup never ran (orphaned clone dir) | Real chunks in Mongo; no graph | If re-run, `insertManyIdempotent` safely no-ops on the already-inserted chunks | None - the unique index prevents it | No - repo doesn't reach `'ready'` until after this point in current code |
| Crash during graph generation | Chunks are safe. Graph generation may have partially run but `RepositoryIntelligencePipeline` never persists a partial/invalid graph - confirmed: it validates invariants before any write and only persists on approval | Real chunks; possibly no graph, or a fully-valid graph if the crash happened after persistence but before the status update | Yes - `findByCommitSha` makes a re-run of `generateGraph` for the same `repositoryId` safe | None (governed, invariant-checked write) | No |
| GitHub / clone failure | Already handled - caught explicitly, `failImport()` called, repo marked `'failed'` with a message | None (fails before any real work) | Yes, cleanly, today | None | No |
| Embedding provider failure | Caught by the outer try/catch around the whole parsing/embedding block, `failImport()` called | None persisted from this stage | Yes, if the whole pipeline is manually re-triggered from scratch today (no partial resume exists) | None | No |
| Database connection failure mid-pipeline | Depends on exactly which `await` was in flight - likely an unhandled rejection, caught by the `.catch()` in `startImport()`, logged, but `failImport()` itself also requires a DB write to record failure - if the DB is down, even the failure can't be recorded | `Job`/`Repository` frozen at their last successfully-written stage, with no `'failed'` marker | No | None | No - but also no visible failure reason, just silently stuck |
| Duplicate/concurrent job for the same repository | Not prevented at all - confirmed directly: no check for an existing `githubUrl` before `repositoryRepo.create()`. Two imports of the same URL create two entirely separate `Repository` documents, each running its own full, independent pipeline | Two full sets of chunks, two graphs, two everything | N/A - they're independent by design today, not a retry scenario | Yes, functionally - the user ends up with duplicate repository entries in their list, each separately indexed | No, but it is genuinely wasteful and confusing |
| Stale job (crashed worker, no heartbeat) | No detection exists at all. Nothing in this codebase reads `Job.updatedAt` to determine staleness, and no lease/heartbeat/lock field exists on either `Job` or `Repository` (confirmed by a direct search - no matches) | A `Job`/`Repository` frozen indefinitely | No path to retry it exists | N/A | No - but it never resolves either, which is its own real problem |

---

## 3. Durable State Machine — PROPOSED

The current `RepositoryStatus` enum (`'queued' | 'cloning' | 'parsing' | 'embedding' | 'ready' | 'failed'`) and `JobStage` enum (`'cloning' | 'parsing' | 'embedding' | 'complete' | 'failed'`) are close to what's needed, but neither currently has a genuine, durable checkpoint within the `'parsing'`/`'embedding'` window - the real gap this whole design exists to close. Rather than invent new stage names not grounded in the real pipeline (per the task's own explicit instruction not to assume `QUEUED -> CLONING -> ...` is correct), the proposal below is a minimal extension of the states that already exist, adding exactly the checkpoints the failure analysis above shows are missing:

```
queued
  down (worker claims the job - see 7)
cloning
  down (clone succeeds; commitSha now known and durably recorded)
parsing            [NEW CHECKPOINT: chunks-computed-but-not-yet-embedded]
  down (chunking complete, chunk content hashes durably recorded - see 4)
embedding          [NEW CHECKPOINT: embeddings-computed]
  down (insertManyIdempotent succeeds - already durable today)
extracting         [graph generation, already independently resumable]
  down
ready  /  failed
```

Two states are added in spirit, not necessarily as new enum values on `Job.stage` (see 4 for why the checkpoint itself, not a new stage name, is the actual fix):

- The `'parsing'` stage's meaning is extended: today it merely marks "chunking is in progress"; it should durably record that chunking finished and exactly what was produced, before entering `'embedding'`.
- No new terminal states are needed. `'ready'` and `'failed'` remain correct as-is.

Explicit rejection of a `queued -> cloning -> parsing -> chunking -> embedding -> extracting -> governing -> persisting -> completed` fine-grained model: the task's own example is deliberately not followed literally, because the real pipeline does not durably persist any intermediate artifact between clone and chunk-insert today - inventing five new named states without also inventing five new durable checkpoints to back them would create the appearance of granularity without the substance. The state machine should have exactly as many states as there are genuine durable boundaries, per the task's own instruction ("do not create excessive states merely for appearance").

---

## 4. Checkpoint Design — PROPOSED

Answering the task's own framing question - "if the process dies immediately after this stage, what allows the next attempt to continue safely?" - for each real stage:

- After clone: the only thing worth persisting is `commitSha` (already done, today, at the `'parsing'` status transition) and the local clone path - but the local clone path is not portable across a process restart (a new process, especially in a redeployed container, will not have the same filesystem state). Conclusion: clone is not a resumable checkpoint - it is a cheap, idempotent operation that should simply be re-run from scratch on any retry. Attempting to persist and resume from a partial clone would add real complexity for a step that's fast relative to embedding.

- After chunk (before embed): this is the first checkpoint genuinely worth adding. PROPOSED: persist the chunk content (path, line range, content, contentHash, chunkType, symbolName, language) durably - without embeddings yet - as soon as chunking finishes, rather than holding it in memory through the entire embedding step. This durably answers "what work was already done" independent of whether embedding ever completes. A resumed job can then query "which of my already-computed chunks still need an embedding" rather than re-cloning and re-chunking from scratch.

- After embed (before insert): given chunk-insert is already a single idempotent batch operation, there's no need for a separate embedding-only checkpoint - the natural checkpoint is chunk+embedding persisted together, exactly as it happens today.

- After chunk+embedding persistence: already fully durable and already the correct checkpoint. Nothing to change.

- After graph generation: already fully durable and already correctly checkpointed via `findByCommitSha`. Nothing to change.

What NOT to store, per the task's own explicit instruction: no "progress: 47%" style figures beyond what already exists (the current `Job.progress` field is coarse but at least tied to real stage transitions, not a fabricated smooth percentage - it should probably be reconsidered for removal or made purely cosmetic, since it doesn't actually reflect checkpointable progress). The durable facts worth storing are: `commitSha` (already done), a chunking-complete marker with a count (PROPOSED), and the existing chunk/graph documents themselves - not synthetic progress numbers.

---

## 5. Idempotency

Answered directly from verified behavior, not assumed:

- Embedding generation run twice: no duplicate chunks can result, because `insertManyIdempotent`'s unique index (`{repositoryId, commitSha, contentHash}`) rejects duplicates at the database level - confirmed directly in `chunk.model.ts:44` and the duplicate-key-error handling in `chunk.repository.ts`. Re-running embedding itself (the actual embedding computation) is wasteful if repeated unnecessarily, but not unsafe.

- Graph extraction run twice: no duplicate nodes/edges can result for the same `(repositoryId, commitSha)`, because `RepositoryIntelligencePipeline.generateGraph()` checks `findByCommitSha` first and returns `already_exists` without regenerating anything - confirmed directly in `repository-intelligence-pipeline.ts:34-36`. This is real, existing, verified protection, not something this design needs to add.

- Same repository imported twice (same URL, potentially different commit over time, or literally the same commit): confirmed unsafe today - no check exists at all. Each import call creates an entirely new `Repository` document with a new `_id`, and everything downstream (`Chunk`'s unique index is scoped to `repositoryId`, not `githubUrl`) treats it as a completely independent repository. Two imports of the identical URL/commit produce two full, separate, duplicate sets of chunks and two separate graphs. This is a real, intentional design question for approval (see Open Questions), not something to silently fix as part of "durability."

---

## 6. Job Identity

The task's own example hierarchy (`User -> Repository -> Repository Version -> Processing Job`) does not match the real schema - confirmed directly, not assumed. The actual, current hierarchy is:

```
User
  down (ownerId)
Repository            (each document IS effectively one version/import attempt - commitSha lives directly on it, singular, not as a history)
  down (repositoryId)
Job                   (findLatest sorts by updatedAt DESC, implying the schema already anticipates more than one Job per Repository over time, though today exactly one Job is created per import and never reused)
```

There is no `RepositoryVersion` entity. A "version" is implicitly whatever `commitSha` happens to be stamped on a given `Repository` document at a given time.

For durable job identity specifically, the existing `Job._id` (a real, stable Mongo ObjectId) is already sufficient to survive a process restart - it's a real document, not an in-memory identifier. The actual gap is not identity (which already exists and is durable) but discoverability: nothing currently scans for `Job` documents stuck in a non-terminal state to know a resume is needed at all. That's a section 9 concern, not an identity concern.

---

## 7. Concurrency — PROPOSED, since none of this exists today

Same repository, two imports (confirmed unsafe today, section 5): two independent `Repository`/`Job` pairs are created and run fully independently - no interaction, no lock contention, just duplicated work and duplicated data. Whether this is acceptable, should be rate-limited more aggressively, or should be prevented outright (returning the existing repository if one with the same `githubUrl`+owner already exists) is an open design question, not resolved by this document.

Same job, two workers (not currently possible, since there is exactly one worker - this Node process - and no queue): becomes a real concern only if a genuine job queue (BullMQ, referenced as a future direction directly in this service's own code comment, `repository-import.service.ts:33`) is introduced. PROPOSED, for that future: a job-claim step using an atomic `findOneAndUpdate` with a condition on the current stage (e.g., only transition `queued -> cloning` if the document is still `queued`), which is a standard, simple optimistic-locking pattern - no distributed lock needed, since MongoDB's own atomic document update already provides the necessary guarantee for single-document state transitions.

Retry while the original worker is still running: with the claim pattern above, a second attempt to claim an already-`cloning`/`embedding` job would simply fail its conditional update and back off - it would never proceed to duplicate work.

Worker crashes while holding a "lock": since the proposed claim mechanism above is just a stage value on the document itself (not a true exclusive lock with an owner token), a crashed worker leaves the job stuck at whatever stage it claimed - exactly today's real problem, and exactly what stale-job detection (section 9) exists to resolve, not the claim mechanism itself.

Older repository version finishing after a newer one: does not apply to the current schema as directly as the task's phrasing implies, since there is no version history on a single `Repository` document - each import is an independent document. This concern would only become real if deduplication (treating re-imports of the same URL as new versions of one stable `Repository` entity) is adopted as a future direction - genuinely out of scope for this design unless explicitly approved.

---

## 8. Retry Model — PROPOSED

Retryable (transient, likely to succeed on a second attempt):
- Clone failure due to network issues
- Embedding provider failures - including the real, confirmed rate-limit case from Milestone 4 Task 1 (a `RateLimitError` from Groq is a textbook retryable failure, with the provider's own response even stating a concrete wait time)
- Transient MongoDB connection failures

Permanent (retrying will not help):
- GitHub reports the repository doesn't exist, or access is genuinely forbidden (already distinguished today via `NotFoundError`/`ForbiddenError` at the very start of `startImport`, before any `Repository` document is even created - confirmed in the class-level comment and `fetchRepoInfo` call)
- A repository exceeding `MAX_REPO_FILES`/file-size limits (deterministic, will fail identically every time)

PROPOSED retry parameters: a small, bounded retry count (e.g., 3 attempts) with a real backoff - and specifically, for the rate-limit case, honoring the provider's own stated retry-after duration where available (Groq's real error response includes exactly this, confirmed directly in Task 1's live logs), rather than a generic fixed backoff that might retry too early or unnecessarily late.

---

## 9. Stale Job Recovery — PROPOSED (the source document was truncated at this section; addressed from first principles, grounded in the real facts established above)

Given no heartbeat, lease, or staleness check exists anywhere today (confirmed by direct search), the proposal:

- A job is considered stale if it has been in a non-terminal state (`'cloning'`, `'parsing'`, `'embedding'`) for longer than a reasonable ceiling for that stage - informed by real, measured numbers from Task 1 (embedding alone took 156s for 56 files; a generous multiple of the worst real number observed, not a guess, should set this threshold).
- Detection requires something to periodically check `Job.updatedAt` against this threshold - today, nothing does this. This would need either a scheduled check (a simple periodic sweep) or a check performed lazily when the repository's status is next queried by a user (cheaper to build, though only self-heals when someone actually looks).
- On detecting staleness: mark the job `'failed'` with a clear, honest reason ("processing did not complete within the expected time and appears to have stopped"), rather than leaving it silently frozen forever - the single biggest, most concrete improvement this whole task can deliver over today's real, confirmed behavior (permanently stuck jobs with zero recovery path).
- Whether "stale" should trigger an automatic retry (re-running the pipeline from scratch, since - per section 4 - clone/chunk/embed are not yet resumable mid-flight) or simply surface the failure for a user-initiated retry is an open design question, not resolved here.

---

## Open Questions Requiring Your Decision Before Implementation

1. Should re-importing an already-imported `githubUrl` be prevented, deduplicated, or left as-is (creating a fully independent second `Repository`)? This is the single design decision most likely to change the shape of the schema (whether a real `RepositoryVersion`-style model becomes necessary) and should be resolved before any implementation begins.
2. Should stale-job detection be a scheduled background sweep, or a lazy check performed on read? The lazy approach is simpler and needs no new infrastructure; the scheduled approach recovers stuck jobs even if nobody is actively looking.
3. Should a detected stale job automatically retry, or only surface as failed for a manual retry? Given clone/chunk/embed are not resumable mid-stage (section 4), an automatic retry today means restarting that portion from scratch - worth confirming that's acceptable before building auto-retry logic.
4. Is the orphaned-graph-on-delete finding (discovered incidentally during this inspection - repository deletion cleans up chats, jobs, and chunks, but never the knowledge graph collection, confirmed directly in `repository-management.service.ts:59-78`) in scope for this task, or tracked separately? It's real, but not part of "import job durability" as scoped.

---

*End of design document. No implementation should begin until these open questions are resolved and the design above is explicitly approved.*
