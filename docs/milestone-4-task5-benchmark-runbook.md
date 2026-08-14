# Milestone 4 Task 5 — Capacity + Performance Benchmark: Runbook

**Status: methodology and instrumentation complete. Execution requires your own machine** (real MongoDB, real Groq API access, real browser) - this sandbox cannot run any of it. This document is both the required Section 1-4 report and the exact runbook for the rest.

---

## Section 1 — Real, Verified Configuration (not assumed)

Checked directly against `apps/api/src/config/env.ts` and `package.json` in this session:

| Setting | Real value |
|---|---|
| `MAX_REPO_FILES` | **3000** (confirmed, not assumed) |
| `MAX_FILE_SIZE_KB` | 500 |
| `LOCAL_EMBEDDING_MODEL` | `onnx-community/all-MiniLM-L6-v2-ONNX` (local, no external API call) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `GROQ_MAX_TOKENS` | 1024 |
| `CHAT_RETRIEVAL_TOP_K` | 8 |
| `STALE_JOB_THRESHOLD_MS` | 600,000 (10 min) |
| `STALE_JOB_SWEEP_INTERVAL_MS` | 60,000 (1 min) |
| mongoose | ^8.5.1 |
| express | ^4.19.2 |
| `@huggingface/transformers` | 4.2.0 |
| groq-sdk | 1.5.0 |
| Node.js (this session) | v22.22.2 - confirm your own machine's version separately, it may differ |

**A real gap found and fixed during this inspection**: `ChunkCheckpointModel` (added Milestone 4 Task 3) was missing from the startup index-readiness check in `db.ts`, despite the code's own explicit principle that every new indexed model gets added to that list deliberately. Fixed - a large benchmark import will exercise this index heavily, and an inaccurate "why was this slower than expected" measurement would help no one.

**Real environment values you must fill in yourself** (this sandbox has none of these):
- Operating system, CPU, RAM, GPU
- MongoDB version/hosting (Atlas tier, region)
- Actual deployed vs. local environment for this benchmark run

---

## New instrumentation added this task (measurement only, verified compiling and passing all existing tests)

Every addition below is purely additive - no behavior change, confirmed by the full existing test suite still passing (364 backend tests, 100 frontend tests).

- **`repository-intelligence-pipeline.ts`**: separate `governanceMs` (dedup + validation) and `persistenceMs` (the real `insert()` call) - previously combined into one undifferentiated `graphMs`.
- **`knowledge-graph-generation.service.ts`**: separate `deterministicExtractionMs` and `inferredExtractionMs` - the inferred tier makes real per-file LLM calls, already known from Task 1 to be a major cost driver.
- **`chat-orchestration.service.ts`**: `timeToFirstTokenMs`, `streamingDurationMs`, `outputCharacterCount`, `charactersPerSecond` - none of this existed before; Section 10/11's entire requirement was previously unmeasurable.
- **Frontend** (`graph-api.ts`, `use-elk-layout.ts`, `RepositoryGraph.tsx`): real `console.log('[benchmark] ...')` lines for graph request time, transformation time, ELK layout time, and an honest approximate render time (via `requestAnimationFrame`, which only fires after a genuine paint - not a claimed exact frame-rate measurement, per this task's own explicit instruction not to manufacture precision).

**To capture these**: run the backend with real log output visible, and open the browser DevTools console while using the real frontend. Every `[benchmark]`-prefixed console line and every backend `logger.info` line with a `stages` object is real data for this task.

---

## Section 2 — Benchmark Repository Selection

**Confirmed, real four-point scaling curve** (per the approved methodology - real file counts verified directly via the GitHub API using your own token, not guessed):

| Scenario | Repository | Real file count | % of 3000 ceiling |
|---|---|---|---|
| Small | `sindresorhus/is-fullwidth-code-point` | 6 | 0.2% |
| Medium | `shivangsatiya/Realtime-Chat-App` | 70 | 2.3% |
| Large | `date-fns/date-fns` | 1,903 | 63% |
| **Near-limit (primary benchmark)** | `pandas-dev/pandas` | 2,649 | **88%** |

**Once you pin a commit SHA for each, record before running anything else:**
- Real file count *this pipeline actually processes* (compare against `MAX_REPO_FILES`/`MAX_FILE_SIZE_KB` - some files will be excluded by size or extension). For `pandas` specifically, the raw GitHub count of 2,649 almost certainly includes real non-Python files (`.pyx`, `.c`, `.h`, docs, config) that this pipeline's own extension filter will exclude - the gap between "2,649 reported" and "N actually processed" is itself a real, worth-recording data point, not noise to ignore.
- Approximate repository size, language composition

---

## IMPORTANT — Approved Methodology Refinement (deterministic vs. LLM-inferred capacity)

Per explicit instruction: **this project must remain completely free.** No Groq credits, no paid LLM/embedding/database/infrastructure of any kind will be purchased for this benchmark, under any circumstance.

**A real, confirmed constraint found while preparing this refinement**: `inferred-annotation-extractor.ts`'s own original doc comment cited `MAX_REPO_FILES=15` as the reason one-LLM-call-per-file was an acceptable design - a stale number, now corrected to the real, confirmed 3000. At the real scale this benchmark now targets, that design choice becomes a genuine, measured bottleneck: a repository near the 3000-file ceiling makes thousands of individual Groq calls for inferred extraction alone, and the free-tier daily quota (100,000 tokens) will not come close to completing that for a repository the size of `pandas`.

**This is treated as a real capacity constraint of the free LLM dependency, not a benchmark failure** - the pipeline's own existing graceful-degradation behavior (each file's inferred extraction attempted independently, a failure skips that one file's inferred layer without affecting anything else) is left completely unchanged. New instrumentation added this task (`inferred-annotation-extractor.ts`) now reports a real, honest summary at the end of every extraction pass:

```
attemptedCount            - total files inferred extraction was attempted for
succeededCount             - files that genuinely got real, parsed LLM classification
quotaExhaustedCount        - files that failed specifically due to a real, typed 429 (Groq's own RateLimitError)
otherFailureCount          - files that failed for any other reason (parse failure, network, etc.)
inferredCoveragePercent    - succeededCount / attemptedCount, as an honest percentage - never claims full coverage when it wasn't
firstQuotaExhaustedAtFile  - the real file path where quota exhaustion was first detected
```

The 429 detection is real and typed - confirmed directly against `groq-sdk`'s own error hierarchy (`RateLimitError extends APIError<429, Headers>`), not guessed from an error message's text. Verified with three new, dedicated tests (all-quota-exhausted, all-other-failure, and a real mixed run partway through).

**When you run the `pandas` (near-limit) import, this summary log line is the real, authoritative source for the deterministic-vs-inferred split the approved methodology requires** - report `inferredCoveragePercent` and `firstQuotaExhaustedAtFile` directly from it, rather than manually counting per-file warning logs. Deterministic graph generation (Tier 1/2, the AST-based extraction) is entirely separate from this and is not affected by LLM quota at all - it should complete in full regardless of how much of the inferred tier succeeds, and that fact itself (deterministic completeness vs. inferred partial coverage) is the core finding this refined methodology exists to surface cleanly.

---

## Section 3 — Reproducibility Checklist

Fill in for every benchmark run, not just the first:

```
Application
  commit SHA:        <git rev-parse HEAD in ai-codebase-assistant itself>
  branch/tag:
  benchmark version:  this document's own git history

Environment
  OS:
  CPU:
  RAM:
  GPU (if relevant to local embedding):
  Node.js version:    (confirm - v22.22.2 was only THIS sandbox's version)
  Python version:     (if relevant to any tooling used)

Infrastructure
  MongoDB version/tier:
  Vector index configuration:
  LLM provider/model:      llama-3.3-70b-versatile (Groq) - confirmed, do not switch for this benchmark
  Embedding provider/model: onnx-community/all-MiniLM-L6-v2-ONNX (local) - confirmed

Repository
  owner/repo:
  commit SHA:
  file count (reported):
  file count (processed):
  language breakdown:

Runtime
  MAX_REPO_FILES:            3000 (confirmed)
  MAX_FILE_SIZE_KB:          500 (confirmed)
  CHAT_RETRIEVAL_TOP_K:      8 (confirmed)
  Concurrency settings:       (none beyond Node's own event loop - confirmed no worker pool exists)
```

**Never record**: API keys, tokens, passwords, private repository credentials. If any log line captured during this process contains a token, redact it before saving.

---

## Section 4 — Warmup Methodology

- **Cold run**: first request immediately after `npm run dev:api` starts (or a fresh deploy). The local embedding model's very first use downloads/caches it (confirmed directly in existing logs: `"Loading local embedding model (first use downloads and caches it)"`) - this alone could dominate a genuinely cold first run and should be reported separately, not folded into a "typical" number.
- **Warm run**: any request after the process has been running normally for a few minutes with at least one prior real import completed.
- **Do not** artificially warm caches beyond what a real user's second real action would naturally trigger.

---

## Section 5 — Repository Import Benchmark

The pipeline already logs every real stage in one place - no separate benchmark script needed for this section. Run a real import of the selected repository and capture the full sequence of these real log lines (all already existed except the two graph sub-stage additions from this task):

```
Clone complete              -> durationMs
File walk complete          -> durationMs
Chunking complete           -> durationMs
Embedding complete          -> durationMs
Chunks stored                -> durationMs
Graph extraction complete    -> deterministicExtractionMs, inferredExtractionMs   [NEW this task]
Repository Intelligence Pipeline approved and persisted graph -> governanceMs, persistenceMs   [NEW this task]
Import complete               -> the full summary, stages: {cloneMs, walkMs, chunkMs, embedMs, storeMs, graphMs}
```

`graphMs` in the final summary is the *outer* measurement (extraction + governance + persistence combined, plus any orchestration overhead around them) - the two new, finer-grained log lines let you see whether extraction (specifically the *inferred* tier's real per-file LLM calls) or governance/persistence actually dominates that number. Report both: the outer `graphMs` for the headline total, and the breakdown for the "likely cause" analysis Section 18 requires.

Task 1's own real prior measurement, for direct comparison against this larger benchmark: 156s embedding / 167s graph generation for a 56-file repository - verify directly whether embedding remains the dominant cost at this new, much larger scale, or whether graph generation (specifically the inferred/LLM tier) overtakes it, since the inferred extractor makes one real LLM call per file, and file count is about to increase by roughly 50x.

---

## Section 6 — Durability Overhead

**Honest scope limitation, stated directly rather than glossed over**: a true "before Task 4" comparison is impossible - the pre-Task-4 implementation no longer exists in this codebase, and fabricating historical numbers would violate this task's own explicit instruction. What *can* be measured, and should be:

- Checkpoint write duration: already logged as part of the real `chunkMs`/`storeMs` window (the checkpoint write happens between chunking and embedding - a real, small addition to that window, not a separate log line currently).
- A real recovery/retry comparison: manually trigger a resume (kill the process mid-import on a real, disposable test repository, wait for the stale-job sweep to claim it - up to `STALE_JOB_SWEEP_INTERVAL_MS` + `STALE_JOB_THRESHOLD_MS` in the worst case, or lower the threshold via env vars *for this one disposable benchmark run only* to make the wait practical) and compare its `Import complete` summary's `resumedFromCheckpoint: true` stages against a normal, uninterrupted import's `resumedFromCheckpoint: false` stages for the same repository. The `chunkMs`/`walkMs` should be near-zero on the resumed run (checkpoint reuse skipping re-chunking entirely) - this delta *is* the real, measurable value of Task 4.3's checkpoint.

---

## Section 7 — Database Measurements

Real counts, queryable directly against your own MongoDB after a real import:
```js
db.chunks.countDocuments({ repositoryId: ObjectId("...") })
db.repositoryknowledgegraphs.findOne({ repositoryId: ObjectId("...") }, { "nodes": 1, "edges": 1 })
  // nodes.length / edges.length for real counts
```
Chunk/embedding counts are also already logged directly (`"Chunks stored" -> inserted, skippedDuplicates`). Database write duration for the chunk-insert step is already logged (`storeMs`). A representative query-latency sample for `db.chunks.find({ repositoryId })` and the real `$vectorSearch` aggregation (via MongoDB's own `explain()`, or simple client-side timing) covers this section without needing a general-purpose database benchmark, which is explicitly out of scope.

---

## Section 8 — Graph Capacity

Real, already-available data: the `Repository Intelligence Pipeline approved and persisted graph` log line already reports `nodeCount`/`edgeCount`. For breakdown by type, query the real graph document directly:
```js
db.repositoryknowledgegraphs.findOne(
  { repositoryId: ObjectId("...") },
  { nodes: 1 }
).nodes.reduce((acc, n) => { acc[n.type] = (acc[n.type]||0)+1; return acc; }, {})
```
Run the same reduction on `.edges` grouped by `type`. Report only the categories the real graph actually contains for this repository - do not invent categories it doesn't produce.

---

## Section 9 — Retrieval Benchmark

`RetrievalService` already logs `embedMs`/`vectorSearchMs` per real call (confirmed directly in existing logs: `"Retrieval complete" -> stages: {embedMs, vectorSearchMs}`). Run several genuinely different questions against the imported repository through the real `/graph/ask` (deterministic) and chat (`/messages`, semantic) endpoints - not one lucky query. For graph queries specifically, use only query shapes the real, current API actually supports (confirm via `knowledge-graph.routes.ts`'s real `/:id/graph/analysis/:algorithm` options before choosing examples) rather than assuming a shape exists.

---

## Section 10-11 — AI / SSE Benchmark and Repetition

Now fully instrumented (this task's new work) - every real chat turn logs `timeToFirstTokenMs`, `streamingDurationMs`, `outputCharacterCount`, `charactersPerSecond` directly. Run at minimum 5-10 real questions against the benchmark repository (more if practical) and compute min/median/p95/max from the real logged values. If the sample stays small, say so explicitly rather than presenting a median of 5 as if it were statistically robust - this task's own instruction against manufactured confidence applies directly here.

---

## Section 12 — Import Benchmark Repetition Methodology

**Chosen methodology, stated before running anything expensive**: a single, correctness-and-reproducibility-prioritized run against the pinned benchmark repository, in a local (not production) environment, using a disposable test account - not a repeated production import. This matches the same disposable-account pattern already established and used successfully in this project's own Task 2 smoke tests. Re-running the *same* import a second time will naturally exercise the duplicate-import protection (Task 4.2) rather than a fresh pipeline run - if a second real timing sample is wanted, either delete the repository between runs or accept that the second run measures something different (the "already exists" fast path, itself a real and worth-recording number).

---

## Section 13 — Frontend Graph Performance

Now instrumented (this task's new work). With the real frontend running and the benchmark repository's graph open, watch the browser console for the `[benchmark]`-prefixed lines: graph request, transform, ELK layout, and approximate render. For interaction responsiveness (node selection, hover, zoom, pan, fit-to-view), this task deliberately does not claim a precise frame-rate measurement, since no reliable mechanism for one exists in this codebase - report a qualitative assessment (smooth / noticeably laggy / unresponsive) rather than a fabricated number, exactly as this task's own instruction requires when a metric can't be reliably measured.

---

## Section 14 — Graph Size Scenarios

The confirmed, real four-point scaling curve from Section 2:
- **Small**: `sindresorhus/is-fullwidth-code-point` (6 files)
- **Medium**: `shivangsatiya/Realtime-Chat-App` (70 files)
- **Large**: `date-fns/date-fns` (1,903 files)
- **Near-limit**: `pandas-dev/pandas` (2,649 files - the primary benchmark)

For each, record file count, real graph node/edge count, real ELK layout time, real approximate render time (from the new frontend instrumentation), and - if reliably observable - a rough memory delta (see Section 15). For the two larger points specifically, also record the deterministic-vs-inferred coverage split from the new summary log (see the Methodology Refinement above) - the scaling curve for deterministic capacity and the scaling curve for LLM-inferred capacity are genuinely different questions, and should be reported as two separate lines on the same table, not blended into one.

---

## Section 15 — Memory / Resource Usage

**Measurement method, stated explicitly per this task's own requirement**: Node.js process-level memory only, via `process.memoryUsage().rss` sampled before and during a real import (a simple `setInterval` logging this during a manual benchmark run is sufficient - not a permanent addition to production code, since this is a one-off measurement task, not new production instrumentation). This measures *this process's* memory, not system-wide usage - report it as exactly that, not as a system-wide claim. For frontend memory, Chrome DevTools' own Memory tab, taken as a heap snapshot after graph load, is the real, honest measurement method - not a number synthesized without actually opening DevTools.

---

## Section 16 — Failure / Capacity Boundary

A real, direct test of `MAX_REPO_FILES` enforcement - confirm using a repository just under, at, and over 3000 files (or, more practically, temporarily lower `MAX_REPO_FILES` in a disposable local `.env` to a small number like 5, and use a real repository with slightly more files than that, to make this genuinely testable without needing to locate a real 3000+-file repository specifically for this one check). Verify directly:
- The import is rejected cleanly (confirm the real error path in `repository-import.service.ts`/`repo-file-walker.ts` - does it throw before or after cloning?)
- The job's real final state (never silently 'ready')
- Whether any partial chunks/data were written before the rejection
- The real error message/classification returned to the caller

---

## Section 17 — No Artificial Optimization

Explicit confirmation: no production code in this task's changes alters timeouts, limits, durability behavior, governance, embedding, graph generation, output size, or model selection. Every change is either read-only inspection or additive `performance.now()`/`console.log` instrumentation, verified by the full existing test suite passing unchanged.

---

## Section 18 — Bottleneck Analysis Template

Fill in once real numbers exist, in the exact format the original task spec requires:

```text
<Stage name>
<measured duration>
<percentage of total time, where meaningful>

Likely cause:
<based on real evidence gathered above, not speculation>

Impact:
<user-facing consequence>

Recommendation:
<optimize now / optimize later / acceptable as-is - do not act on this within Task 5 itself>
```

---

*This runbook is the complete Task 5 deliverable this session can produce without real infrastructure access. Please run through Sections 2-16 on your own machine and report back the real captured values - Section 18's analysis and any final Task 5 report will follow against genuine numbers, not estimates.*
