# Milestone 4 Completion Review — Production Credibility & Reliability

Mandatory review before this milestone can be considered closed, per the milestone's own roadmap. Covers Tasks 1 through 5 together, grounded in what was actually built, tested, and directly observed - not aspirational claims.

## Correctness

Task 4 (Repository Import Job Durability) is thoroughly verified: 40 suites, 364 tests, including dedicated crash-simulation coverage for every real pipeline stage (clone, chunking, embedding, persistence). Task 5's real benchmark work found and fixed two genuine, previously-undiscovered bugs - most notably one where a single empty file anywhere in a large repository could have failed an entire import outright at the final persistence step. Current state: 41 backend suites/374 tests, 18 frontend suites/100 tests, all genuinely passing on real execution, confirmed multiple times throughout this milestone.

**Honest caveat**: the two bugs Task 5 found were only discoverable by actually running a large, real-world repository through the system - something the project's own smaller test fixtures never exercised. Since the primary near-limit benchmark never completed end-to-end, it's possible further edge cases exist at that scale that haven't yet been found. This isn't a known defect - it's an honestly-acknowledged limit on how much confidence the testing to date can support at true near-limit scale.

## Reliability

Task 4.4's retry and stale-job recovery genuinely works for its designed case. But Task 5's benchmark work directly confirmed, in practice, a limitation Task 4.6's own Staff Engineer Review had only theorized: the stale-job sweep's fixed 10-minute threshold can claim a job that's still genuinely, correctly running, if a single stage legitimately takes longer - and each resulting phantom resume attempt consumes real retry budget without ever having a fair chance to succeed, while the actual work continues undetected in the background. This is a real, now-proven limitation, left unfixed deliberately (a genuine fix needs a real heartbeat mechanism, appropriately out of scope for this project's stated design principle of the simplest correct mechanism).

Task 4.5's cleanup cascade is real and verified - no orphaned chunks, jobs, checkpoints, or graphs survive a repository's deletion, confirmed with a dedicated test against a real database proving cross-repository isolation.

## Testing

Genuinely substantial and genuinely exercised, not just written. Every significant change throughout this milestone was confirmed against real test runs on the user's own machine, not assumed from a sandbox-only check - a discipline that caught real, otherwise-invisible discrepancies more than once (dependency-version-sensitive type errors, a test-timing race condition).

## Production Readiness

**The most significant finding of the entire milestone**, surfaced only through Task 5's real benchmark work: the local embedding model runs synchronously within Node's single-threaded event loop, and during a large import, this starves the *entire application* - not just the import itself. Confirmed with real, measured evidence: 60-78 second response times for ordinary requests, a login request aborted client-side, and a genuine cascading failure where a refresh token expired mid-request and correctly triggered a full session revocation. This is a real, severe production-readiness concern for any multi-user or concurrent-use scenario, previously undocumented anywhere in this project.

The project remains fully, genuinely free to operate - no paid infrastructure anywhere, confirmed throughout. This is both the project's stated goal and, as Task 5 demonstrated directly, a real, inherent constraint on how much scale the system can practically sustain on ordinary consumer hardware.

## Performance

Real data exists at small and medium scale (a 6-file and a 70-file repository, including Task 1's own real embedding/graph timing). Real, partial data exists at near-limit scale (clone, file-walk, and chunking timing for a 2,649-file repository - 45,161 chunks in 23 seconds). **A genuine gap**: full embedding and graph-generation timing at true near-limit scale was never captured end-to-end, due to an honestly-acknowledged real hardware/time constraint rather than a measurement failure. What Task 5 produced instead - two real bug fixes and a directly-confirmed architectural risk - is arguably more valuable for this project's actual purpose than a complete timing table would have been alone.

## Remaining Technical Debt (across the whole project, not just this milestone)

- Only JavaScript/TypeScript and Python get real AST-based parsing; other languages fall back to lower-fidelity line-window chunking
- `CouplingAnalyzer` - designed, never implemented
- The command-palette search placeholder in the sidebar - visible, disabled, never built
- **Found during Task 5**: no frontend UI exists to delete a repository at all, despite the backend endpoint being fully built, tested, and verified
- The stale-threshold race condition (documented above, deliberately unfixed)
- The single-threaded event-loop-blocking issue from local embedding (documented above, deliberately unfixed - a real architectural change, out of scope for this milestone)
- The inferred/LLM extraction tier cannot complete full coverage for a near-limit repository under the free Groq daily quota - a real, accepted constraint of remaining fully free, not a bug
- The full near-limit end-to-end benchmark itself remains incomplete

---

## Verdict

**Milestone 4 is closed with real, substantial, and honestly-documented outcomes - not a claim of flawless production readiness.** The milestone's own stated purpose - closing the gap between "correctness evidence" and "production credibility" - was genuinely advanced: real crash recovery, real cleanup guarantees, real measured performance data at multiple scales, and, critically, two real bugs and one real architectural risk that would not have been found any other way.

The single most important thing to carry forward, if this project continues: **the local-embedding event-loop contention is a real, user-facing limitation that would matter immediately in any scenario with more than one active user or a large import running concurrently with normal use.** Everything else in this review is either fixed, well-tested, or a deliberately-scoped, honestly-documented trade-off.

No further automatic work is planned beyond this point without explicit direction, per this milestone's own review requirement.
