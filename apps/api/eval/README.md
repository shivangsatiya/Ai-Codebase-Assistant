# Retrieval + Question-Routing Evaluation Harness

Replaces "we manually tested retrieval and routing" with a reproducible, versioned dataset and a script that produces real, measured numbers from a real running backend.

## What this is, and isn't

This runs real questions against a real `/graph/ask` endpoint and scores the real responses. It is **not** a mock, a simulation, or a source of fabricated numbers. Every number in a generated report reflects an actual API call made when the script ran.

**This document does not itself contain evaluation results.** The scoring logic (`scoring.ts`) is unit tested and verified (see `tests/eval-scoring.test.ts`), but the *runner* (`run-evaluation.ts`) needs a real backend with real credentials and real imported repositories - something this sandbox does not have access to. Running it and interpreting the results is the next real step, not something this delivery can honestly claim to have already done.

## Files

- `types.ts` - shared types for the dataset and the report
- `golden-dataset.ts` - 22 questions across 2 real repositories (klona, Realtime-Chat-App), every expected category traced by hand through the actual `classify()` implementation before being written down
- `scoring.ts` - pure, unit-tested scoring logic (confusion matrix, per-category accuracy, entity recall) - no network calls, fully testable in isolation
- `run-evaluation.ts` - the actual runner: registers a disposable eval account, imports or reuses each repository, waits for readiness, resolves node-label hints against the real graph, calls the real `/graph/ask` for every question, scores the results, writes a JSON report

## A real, important finding baked into the dataset

`pure_semantic` is a valid TypeScript type in `question-router.ts` but is never actually produced by the real `classify()` implementation - every question that doesn't match a dependency/cycle/path keyword falls through to the same default as an explicit "why"/"explain" question: `hybrid`. This was verified by reading the actual classifier code, not assumed. Questions in the dataset that are conceptually "pure semantic" (e.g., "Does this repository use a database?") are labeled `expectedCategory: 'hybrid'` to match real system behavior, not the four-way split the original design implied.

## Running it

```bash
# From apps/api/, against a locally running backend:
npm run dev              # in one terminal
BASE_URL=http://localhost:4000 npm run eval    # in another

# Against a deployed backend:
BASE_URL=https://ai-codebase-assistant-api.onrender.com npm run eval
```

No special environment variables are required beyond BASE_URL (defaults to http://localhost:4000) - the script registers its own disposable account per run, so it doesn't depend on any pre-existing credentials.

Expect this to take several minutes. If either repository isn't already imported under the account the script creates, it will import fresh and poll for readiness (up to 5 minutes per repository) - import time itself has never been measured in this project (see the Milestone 3 retrospective's Performance section), so this is genuinely unknown in advance.

## Reading the output

The script prints a live summary per question as it runs, then writes a full JSON report (report-<timestamp>.json) containing every individual result - including the actual answer text, for manual review against each question's criteria field, which is not something this harness scores automatically (see "What this doesn't measure" below).

## What this doesn't measure

Per the task's own explicit instruction not to invent metrics from insufficient data:

- Recall@K / Precision@K in the formal information-retrieval sense are not computed. Building a real relevance-labeled corpus (which chunks are actually relevant to which question) was out of scope for this pass - entitiesFound/entitiesMissing is a much looser, substring-based proxy for "did the answer mention what it should have," not a rigorous retrieval metric. This is a known limitation, not an oversight.
- Subjective answer quality (is the explanation actually good, not just topically relevant) is not scored automatically at all - the criteria field on each question exists specifically for a human to check against the real answerText in the report.
- The known klona misclassification probe (K6) requires manually reading the real answer in the report and checking it against the criteria (does it incorrectly claim a database exists) - this is intentional, not a gap, since a substring match alone can't reliably detect a false claim.

## Known limitation of substring-based entity scoring

Plain substring matching has no stemming - "caching" does not match the exact substring "cache". Where this matters, the dataset uses word stems directly (e.g., 'clon' instead of 'clone', to correctly match both "clone" and "cloning"). This is documented directly in tests/eval-scoring.test.ts with a dedicated test proving the limitation is real and understood, not accidentally introduced.
