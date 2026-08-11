# Production Smoke Test

## Purpose

Answers one question: **is the deployed backend's critical end-to-end path healthy right now?** Not a substitute for the unit test suite, the evaluation harness (`apps/api/eval/`), or a future E2E suite - those check correctness and quality in depth. This checks that the real, live system is actually up and the critical flow actually works, in a few minutes, right after a deploy.

## What it covers

```
Health checks (liveness/readiness)
  down
Unauthenticated request correctly rejected
  down
Register a disposable account
  down
Import a real repository
  down
Poll until ready (bounded timeout, real terminal-state detection - never a blind sleep)
  down
Knowledge graph reaches 'ready' (a genuinely separate state machine from repository status - checked explicitly)
  down
Architecture Intelligence: cycle detection returns a real, valid result
  down
/graph/ask - deterministic path (Pure Graph, immediate JSON)
  down
/graph/ask - AI/SSE path (real streamed answer, real token accumulation)
  down
Authorization: a second user cannot access this repository (asserts the real anti-enumeration behavior - identical 404, not a guessed status code)
  down
Cleanup: the test repository is deleted
```

## Files

- `smoke-test.ps1` - the script you actually run
- `smoke-test-lib.psm1` - testable helper functions (SSE parsing, polling, safe error formatting) the main script uses
- `smoke-test-lib.Tests.ps1` - Pester tests for the helper library

## Running it

```powershell
# Against a local backend (npm run dev:api running separately):
.\smoke-test.ps1 -BaseUrl "http://localhost:4000"

# Against a deployed backend:
.\smoke-test.ps1 -BaseUrl "https://your-service.onrender.com"

# Optional overrides:
.\smoke-test.ps1 -BaseUrl "..." -TestRepo "https://github.com/owner/repo" -ImportTimeoutSeconds 300
```

No environment variables or secrets are required. The script registers its own disposable account per run (smoke-test-<random>@example.com), so it never depends on any pre-existing credentials, and never needs a real password or token supplied to it.

## Expected runtime

Not formally measured (repository import time has never been benchmarked anywhere in this project - see the Milestone 3 retrospective's Performance section) but typically a few minutes, dominated almost entirely by the import-readiness poll. Health checks, auth, graph, and /graph/ask calls are each expected to complete in well under the 30-second default HTTP timeout individually.

## Cleanup behavior

The imported test repository is always deleted at the end, even if an earlier step failed - the whole test body runs inside a try/finally, so cleanup happens regardless of what broke. If repository creation itself never succeeded, cleanup is safely skipped (there's nothing to delete) rather than attempting to delete a null ID.

Known, honest limitation, not a workaround: the two disposable smoke-test accounts created each run (the primary account, and a second account created specifically to test cross-user authorization) are not deleted. The real API has no user-deletion endpoint at all - verified directly by reading the actual routes, not assumed. Inventing a destructive workaround (e.g., a direct database delete) around a real, honest API gap would be exactly the kind of thing this task's own instructions warn against. These accounts accumulate over repeated runs; this is a real, stated limitation, not a bug.

## Interpreting a failure

Every step reports its name and a safe (secret-redacted) diagnostic message on failure, then the script continues to the next step rather than stopping immediately - this maximizes how much real information one run gives you. The final summary lists every step that failed by name. A failed "/graph/ask - AI/SSE path" step specifically reports how much content was actually received before the failure (e.g., "AI stream failed after receiving 143 characters"), not just a generic error, since partial progress is itself diagnostic information.

## What this deliberately does NOT check

Per the explicit "keep it a smoke test" instruction: exact node/edge counts, exact AI wording, exact latency, or citations (the real backend does not provide a formal citation contract on /graph/ask's SSE stream - verified directly, not assumed). These are structural/shape checks, not correctness or quality checks.

## A real, live-verified operational consideration: shared Groq rate limits

Running `npm run eval` (Milestone 4 Task 1) and this smoke test close together against the same Groq account can genuinely exhaust the daily token quota - confirmed live, three separate times, directly after an evaluation run that made 22 real LLM calls plus 56 per-file inferred-classification calls. **The smoke test now distinguishes this precisely rather than treating it as a hard failure**: if the `/graph/ask` SSE stream opens correctly and the backend reports a real, well-formed `event: error` (meaning the endpoint, routing, auth, and SSE mechanics all genuinely work - only the underlying LLM call itself failed), this is printed as a yellow warning and does not fail the smoke test. Only a genuine infrastructure failure - the stream never opening, or producing zero parseable events at all - still fails hard. This distinction was added deliberately after confirming, directly from server logs across three real runs, that the recurring failure was consistently `RateLimitError` from Groq's own daily quota, not an application defect - each of those three runs independently confirmed the backend's own error handling behaved correctly under a real failure condition, which is itself meaningful evidence, not something a smoke test should punish.

## Windows PowerShell note

`Invoke-WebRequest` calls use `-UseBasicParsing` deliberately - without it, Windows PowerShell 5.1 prompts for interactive confirmation before parsing response content (an IE-engine security prompt), which would hang an automated/CI run waiting for input that never comes.

## Local verification result

Not run from this delivery - see the accompanying task report for why (no live backend reachable from the environment this was authored in, and PowerShell itself is not installable there either).

## Production verification result

Not run from this delivery, for the same reason. Do not treat "the code was written carefully" as equivalent to "this was verified running." Running this script against a real backend (local or deployed) is a required, outstanding step before this can honestly be called verified.
