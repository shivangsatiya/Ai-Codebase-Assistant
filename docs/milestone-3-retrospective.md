# Milestone 3 — Final Retrospective & Engineering Review

**Date:** August 2026
**Scope:** Milestones 1 through 3b, as the system exists today. No implementation changes. No architectural redesign. This is a factual baseline, not a proposal.

**Methodology note:** every specific claim below (test counts, config values, file names, algorithm choices) was verified directly against the current source tree while writing this document, not recalled from memory. Where something could not be verified — a live production metric, an unmeasured latency — this is stated explicitly rather than estimated.

---

## 1. Current System

### End-to-end trace

```
GitHub repository URL
  ↓
POST /api/repositories (repository-import.service.ts)
  ↓ git-cloner.client.ts clones to a temp dir (MAX_REPO_FILES / MAX_FILE_SIZE_KB enforced)
  ↓ repo-file-walker.ts walks the tree
Parsing
  ↓ language-registry.ts + tree-sitter WASM grammars (JS/TS, Python)
  ↓ ast-chunker.ts (symbol-level chunks) / line-window-chunker.ts (fallback for unparseable files)
  ↓ chunking.service.ts orchestrates, local-embedding.client.ts (ONNX, all-MiniLM-L6-v2) embeds each chunk
  ↓ Chunk documents persisted; MongoDB Atlas $vectorSearch index over `embedding`
Extraction (knowledge-graph/ services)
  ↓ deterministic-extractor.ts: folders/files/symbols reshaped from parsed chunks, import-extraction.ts
    resolves import specifiers to file or package nodes, contains edges emitted for every parent/child pair
  ↓ inferred-annotation-extractor.ts: one LLM call per file (Groq/Llama 3.3 70B), classifies
    route/service/controller/dbModel/cache/queue/event/configuration/authComponent — non-fatal per file
Repository Intelligence Pipeline (repository-intelligence-pipeline.ts)
  ↓ the ONLY code path with write authority to the graph collection
  ↓ version check (commitSha) for idempotency, identity generation + canonicalization + dedup
    (deterministic beats inferred on conflict; verified=true if multiple sources agree)
  ↓ provenance stamping, 8 graph-invariant checks (no dangling edges, exactly one root, no orphans, etc.)
  ↓ persist-on-approve or record-failure — never a partial or invalid graph
Repository Knowledge Graph (MongoDB, versioned by commitSha, immutable once written)
  ↓
Architecture Intelligence Engine (architecture-intelligence-engine.ts)
  ↓ a registry of pluggable algorithms: CycleDetector (real Tarjan's SCC over `contains`-excluded,
    import-type edges), DependencyAnalyzer (direct/transitive/path modes, BFS-based)
  ↓ query-time only — nothing here is precomputed into the graph itself
Question Router (question-router.ts)
  ↓ classify(): keyword/pattern heuristics over four categories — pure_graph, intelligence,
    hybrid, pure_semantic — explanatory intent is checked before dependency keywords specifically
    to avoid "why does X depend on Redis" being misclassified as a plain dependency query
  ↓ pure_graph / intelligence → synchronous JSON response (AIE result, no LLM involved)
  ↓ hybrid / pure_semantic → streamed path
Retrieval (retrieval.service.ts)
  ↓ $vectorSearch over Chunk embeddings, filtered by repositoryId
  ↓ for hybrid questions, a best-effort AIE dependency-analysis call also runs, non-fatal if it fails
Local LLM (groq-chat.client.ts, streamCompletion)
  ↓ graph-prompt.ts builds an anti-hallucination system prompt, optionally prefixed with a labeled
    "Graph context" section when hybrid facts are available
  ↓ SSE: `data: {"token":"..."}` events, `event: done`, `event: error` — nothing else
Frontend Orchestrator (apps/web/src/hooks/use-ask-question.ts)
  ↓ the only place response-mode branching logic lives — inspects the real response Content-Type
    to decide JSON vs SSE, since classification is entirely server-owned and cannot be predicted
    client-side from the question text
  ↓ composes the ArchitectureAnswer ViewModel: structured facts (computed, no AI) and streamed
    text (AI-generated) are kept as genuinely separate fields, never merged
Developer Experience Interface (React + Vite, apps/web)
  ↓ React Flow + ELK.js render the graph (contains edges drive a hybrid layered/rectpacking layout;
    every other edge type renders but never influences position)
  ↓ Inspector shows real node data, relationship counts computed client-side from the already-
    fetched graph (zero network calls for hover/selection), and the AI question panel
```

Every stage above is real, running code — this is not the design document's aspirational version of the pipeline; it is what the current source tree actually does.

---

## 2. Current Feature Inventory

### Production-ready

- JWT auth with refresh-token rotation and reuse detection (bcrypt, cost factor 12, configurable 10–15)
- GitHub OAuth for private repository import; tokens encrypted at rest (AES-256-GCM, verified in `token-encryptor.ts`)
- Repository import → parse → chunk → embed → deterministic + inferred graph extraction, end to end
- Vector search retrieval (MongoDB Atlas `$vectorSearch`) with citation-anchored answers for pure semantic chat
- Repository Knowledge Graph: versioned, immutable, invariant-checked before persistence
- Cycle detection and dependency analysis (direct/transitive/path) as real, query-time algorithms
- Four-way question routing (pure_graph / intelligence / hybrid / pure_semantic) with correct SSE/JSON branching
- Full frontend workspace: auth, repository list with live status polling, interactive knowledge graph, node inspection, AI question panel with honest fact/AI-generated labeling
- CI (GitHub Actions): backend and frontend jobs, both currently green
- 301 backend test cases across 35 files; 98 frontend test cases across 17 files

### Working but limited

- **Parsing**: JavaScript/TypeScript and Python only (tree-sitter grammars); anything else falls back to line-window chunking, which loses symbol-level structure
- **Inferred-tier classification accuracy**: observed, not systematically measured — a real live import (klona) produced misclassified `dbModel`/`configuration` nodes for a repository with no real database. Recorded, not fixed, since fixing a single anecdote without an evaluation harness would itself be undisciplined
- **Repository size**: `MAX_REPO_FILES` defaults to 3000 in the current schema (`env.ts`) — a large increase from the 15-file value used during the Milestone 1.5 OOM incident. Whether the *deployed* Render environment currently overrides this default was not independently verified in this review; the code-level default is the only confirmed fact
- **Graph layout**: functional and verified against real repository shapes (see §3), but the underlying node/edge count this has actually been tested against tops out around 137 nodes (Realtime-Chat-App). Behavior at true large-repository scale (thousands of nodes) is unverified
- **Retrieval evaluation**: no systematic accuracy measurement exists for any of the three answer-generation paths (pure semantic chat, hybrid, pure graph) — correctness has been spot-checked via manual smoke testing, never scored against a benchmark set

### Intentionally deferred

- Job durability for the import pipeline (no retry/resume on crash mid-import) — flagged as a Critical gap as far back as Milestone 1.5, still unaddressed
- `metadata.inCycle` / `fanIn` / `fanOut` precomputed graph annotations — described in the original design document, never implemented; the real workaround (a live, separate cycle-detection call) was built specifically because this gap was discovered and reported during Task 3, not silently worked around
- Command-palette search (Cmd+K) — visibly present in the sidebar as a disabled placeholder, never built
- Any CouplingAnalyzer or fan-in/fan-out algorithm — does not exist in any form

---

## 3. Milestone 3 Bugs

Two bugs are called out explicitly per the task's instruction; the rest are included for completeness since they materially shaped how much confidence to place in "tests passed" as a signal on this project.

### External-package graph layout collapse

- **Symptom:** the rendered graph appeared as a single, extremely wide horizontal band — live-verified at roughly 60:1 width-to-height on a real repository, effectively unreadable.
- **Root cause:** two, layered. First, `elk.layered` naturally arranges same-level siblings with no edges between them into one row; a real repository's file/symbol counts per folder produce exactly this shape. Second, and more serious: the layout code assumed exactly one root node. A live repository query (137 nodes) showed 62 roots — every external package dependency (`package:react`, `package:axios`, etc.) has no `contains` parent at all, since packages are referenced only via `imports`. The single-root assumption silently fell back to the original flat layout whenever more than one root existed, meaning the *first* attempted fix never actually ran on real data — it only ever ran on synthetic tests that happened to have exactly one root.
- **Why automated tests initially missed it:** the synthetic test fixtures used to validate the first fix modeled an evenly-distributed, single-root tree. Nothing in the fixture data represented the real, near-universal case of a repository with external dependencies. The tests were internally consistent and green; they simply tested the wrong shape.
- **How real testing exposed it:** a live screenshot from the actual browser, against a real imported repository, looked nothing like the passing synthetic benchmark predicted. Rather than adjust the fix blindly, the actual live graph data was queried directly via the browser console (`fetch` + the real access token) to get real node/edge/root counts, which is what revealed the 62-root figure.
- **Fix:** the layout algorithm now identifies the one root with actual children (the true repository root) and gives it the full nested treatment (`rectpacking` within each container, `layered` only at the outermost level); every other, childless root is grouped into one synthetic external-packages container laid out the same way, rather than being treated as 61 separate, malformed "repositories."
- **Regression test added:** `elk-layout-external-packages.test.ts`, built against a shape matching the exact confirmed live counts (137 nodes, 75 contains edges, 62 standalone roots), asserting the resulting ratio stays well under 10:1 (measured: 2.36:1).

### AI-generated answers mislabeled as computed facts

- **Symptom:** every streamed (Hybrid/Semantic, genuinely LLM-generated) answer displayed the label "Computed directly — no AI involved" — the exact opposite of the truth, and a direct violation of the project's stated epistemic-honesty principle.
- **Root cause:** the orchestrator's JSON-response branch explicitly set `category: result.answer.category` on the answer object; the streaming branch, added in the same function, never set `category` at all. It remained `undefined` for a streamed answer's entire lifecycle. The label logic checks `category` to decide which text to show; `undefined` silently failed the "is this AI-generated" check.
- **Why automated tests initially missed it:** the existing streaming test asserted only on `streamedText` (that tokens accumulated correctly) — it never asserted on `category`. The test suite was, again, internally consistent and green while checking the wrong property.
- **How real testing exposed it:** a live screenshot of a genuine streamed answer, showing clearly LLM-generated prose (multi-paragraph natural-language explanation) under the "Computed directly, no AI" label. This was caught by visually reading the actual rendered output during routine browser verification, not by any specific bug hunt.
- **Fix:** `category: 'hybrid'` is now set explicitly on entering the streaming branch. Reaching that branch at all already guarantees the backend classified the question as one of the two AI categories (hybrid or pure_semantic); the label logic treats both identically, so the specific value doesn't need to distinguish which one.
- **Regression test added:** the existing streaming test in `use-ask-question.test.ts` was extended with an explicit `isAiGenerated(category)` assertion, using the real labeling function rather than a hardcoded string comparison, so this exact class of regression cannot silently return.

### Other real bugs from this milestone, briefly

| Bug | Root cause | Fix |
|---|---|---|
| Zustand infinite render loop in the question history hook | A selector returned a fresh `[]` literal on every call when a node had no history; Zustand's reference-equality snapshot check saw a "new" store value on every render | A single stable, module-level empty-array reference |
| Duplicate-submission race in the ask flow | `isAsking` (React state) is batched/asynchronous; two synchronous calls in the same tick both read a stale `false` | A `useRef` guard, updated synchronously, used only for the duplicate check — state still drives rendering |
| Inspector showed "select a repository" while a genuinely-selected repository was still loading | `!repositoryId || !repository` treated "not yet loaded" identically to "nothing selected," since both leave `repository` undefined | Three explicit states (not-selected / loading / error) instead of two collapsed into one |
| `Github` icon import (graph node rendering) | Assumed the icon existed in `lucide-react` without checking; it doesn't (removed for trademark reasons) | Caught immediately by `tsc`, not a runtime surprise; replaced with a generic icon |
| Two Windows-specific, unreproducible-in-Linux dependency bugs (Vite 8/Rolldown; jsdom 30/`@exodus/bytes`) | Both are genuine upstream packaging bugs in newer major versions, not project code defects | Pinned to older, stable major versions that avoid the broken dependency chains entirely |

---

## 4. Architecture Review

**Repository Intelligence Pipeline.** Strength: this is the strongest-designed component in the system. Sole write authority to the graph, versioned immutability, eight real invariant checks before any persistence — this is the kind of discipline that actually prevents a corrupted graph from ever being queryable. Weakness: it has no durability story of its own; if the process crashes mid-pipeline, there's no resume, only a clean failure record. That's honest, but it's still a real operational gap.

**Repository Knowledge Graph.** Strength: the schema is deliberately open (`metadata: Record<string, unknown>`) rather than over-specified, which turned out to matter — the external-package-root discovery in §3 would have been a much harder bug to diagnose against a rigid schema that implied more structure than the data actually has. Weakness: the open schema also means nothing enforces that `metadata` actually contains what a consumer might expect; the `inCycle`/`fanIn`/`fanOut` gap is a direct consequence of a schema that permits aspiration without requiring delivery.

**Architecture Intelligence Engine.** Strength: genuinely correct, tested algorithms (real Tarjan's SCC, real BFS), registered behind a clean plugin interface. Weakness: only two algorithms exist. A `CouplingAnalyzer` was designed and never built; the AIE's registry pattern is proven but under-populated relative to what the design documents implied was coming.

**Question Router.** Strength: the four-way classification is simple, fast, deterministic, and — critically — it is not an LLM call, so it costs nothing and never hallucinates a category. Weakness: it's keyword/pattern-based, which means it's brittle to phrasing the heuristics didn't anticipate; there is no measured classification accuracy, only the specific edge cases (like "why does X depend on Y" vs a bare dependency keyword) that were caught during Milestone 3a's own test-driven development.

**RAG pipeline.** Strength: real vector search, real citations, real anti-hallucination system prompt. Weakness: zero systematic evaluation. No golden-answer set, no measured retrieval precision/recall, no way to know if a change to the embedding model or chunking strategy made answers better or worse without manually re-reading transcripts.

**Local LLM integration.** Strength: Groq/Llama 3.3 70B via a clean `IChatCompletionProvider` interface — swappable in principle, though never actually swapped. Weakness: "local" is a slight misnomer in the deployed sense — Groq is a hosted inference provider, not a model running on the user's own machine; this distinction matters for anyone asked about it directly (see §9).

**Frontend Orchestrator.** Strength: this held up under real pressure — the single-response-mode-inspection design (checking `Content-Type` rather than guessing from question text) was a genuine, caught-in-review correction to an initial design that would have required duplicating server-side classification logic client-side. Weakness: the orchestrator's category-setting bug (§3) shows that "the orchestration logic lives in one place" doesn't automatically mean that place is bug-free — it means bugs are easier to find and fix once, which is what happened.

**Developer Experience Interface.** Strength: real, verified accessibility work (React Flow's built-in controls checked directly for `aria-label`s, not assumed), a genuinely justified non-generic visual design (the certainty color system carries real meaning), and code-splitting that was verified to actually shrink the main bundle, not just added speculatively. Weakness: zero end-to-end/browser-automation testing exists — every "browser verification" in this entire project was a human manually clicking through Claude-generated instructions and reporting back screenshots. This worked, but it is not repeatable or regression-proof the way the unit test suite is.

---

## 5. Technical Debt

**Critical**

- **No job durability for repository import.** A crash mid-import leaves no resumable state. Must be addressed before any milestone that increases import volume or reliability expectations (e.g., a real multi-user deployment). Exists because the original MVP scope prioritized correctness of the pipeline's *output* over resilience of its *execution*.

**High**

- **No retrieval or classification accuracy evaluation.** There is no way to know if a prompt or chunking change is actually an improvement. Does not block Milestone 4 functionally, but blocks any credible claim of "the AI answers are good" beyond anecdote.
- **No E2E/browser-automation test suite.** Every interaction test in this project is a human-in-the-loop verification. Should be addressed before the project is handed to anyone who isn't personally re-running the manual checklist.
- **Smoke test coverage is stale.** `scripts/smoke-test.ps1` still only exercises the original Milestone 1 backend flow (register → import → chat) — it has never been updated to cover graph generation, cycle detection, or `/graph/ask`. A production deploy could silently break the entire Milestone 3 surface while the smoke test still reports green.

**Medium**

- **Inferred-tier classification accuracy is unmeasured and has at least one confirmed live misclassification** (klona's spurious `dbModel`/`configuration` nodes). Can remain deferred until an evaluation harness exists to measure it properly, rather than chasing a single anecdote.
- **`MAX_REPO_FILES` default (3000) has not been load-tested.** Nothing in this review confirms the pipeline, the graph layout, or the frontend actually perform acceptably at that scale — only that it's the configured ceiling.
- **Only two languages parsed (JS/TS, Python).** Everything else silently degrades to line-window chunking. Fine for the current demo repositories; a real limitation for a general-purpose tool.

**Low**

- **Command-palette search is a non-functional placeholder.** Cosmetic; clearly disabled, not misleading.
- **`CouplingAnalyzer` was designed but never implemented**, leaving the AIE registry under-populated relative to the original design. No current feature depends on it.

---

## 6. Performance

Stated plainly: almost nothing in this system has been formally benchmarked. What follows distinguishes what was actually measured from what has only been observed anecdotally.

- **Graph rendering / layout:** the only real measurement taken is the width-to-height ratio of the ELK layout output against synthetic and real-shaped data (§3) — 60:1 before the fix, 2.36:1 after, on a shape matching a real 137-node repository. Frame-rate, interaction latency, or behavior at 1,000+ nodes: **not measured.**
- **Repository indexing (clone → parse → chunk → embed → graph):** no timing data was captured at any point in this project. **Not measured.**
- **Retrieval ($vectorSearch query latency):** **not measured.**
- **Local LLM latency (Groq):** **not measured.** Anecdotally fast enough that streaming felt responsive during manual testing, which is not a substitute for a number.
- **SSE streaming:** functionally verified (tokens arrive progressively, a real interruption preserves partial output, cancellation works) — but time-to-first-token and tokens-per-second were never measured.
- **Frontend interactions:** hover and node selection were specifically verified to trigger zero additional network requests (a real, tested contract, not just an assumption) — this is the one area with an actual behavioral guarantee behind it, even though it isn't a timing benchmark.
- **Unnecessary network requests:** one was found and fixed before shipping — a planned second call for "Graph Facts" during AI questions was removed once it became clear the same data was already available locally. The dynamic `refetchInterval` for in-progress repository imports was deliberately designed to poll only while something is actually importing, not continuously.

The honest summary: this project has real, tested *correctness* properties (does the right thing happen) and almost no *performance* properties (does it happen fast enough, does it hold up at scale).

---

## 7. Security

- **Authentication:** JWT with bcrypt (cost 12, configurable range enforced by schema), refresh-token rotation with reuse detection — verified in code, not assumed. A used-and-reused refresh token correctly ends the entire session rather than silently continuing.
- **Repository authorization:** ownership checks (`getOwnedRepositoryOrThrow`) never distinguish "doesn't exist" from "exists but isn't yours" in their response — both return an identical 404. This is a real, deliberate anti-enumeration property, verified in both backend tests and frontend handling (the graph view shows the same "not found" message for either case).
- **Token handling (GitHub OAuth):** private repository access tokens are encrypted at rest with AES-256-GCM (verified directly in `token-encryptor.ts`), not stored in plaintext.
- **Frontend token handling:** access and refresh tokens live in `localStorage` (via Zustand's `persist` middleware) — not `httpOnly` cookies. This is a real, standard trade-off (simpler CORS/deployment story, at the cost of XSS-exposed tokens) rather than an oversight, but it should be stated as a trade-off, not glossed over.
- **API validation:** every mutating endpoint checked in this project validates via Zod schemas server-side; the frontend's own client-side checks (e.g., the GitHub URL format check before import) are explicitly treated as a UX nicety, never a trust boundary — the actual constitution note in the code makes this explicit.
- **Logging:** a dedicated redaction test (`logger-redaction.test.ts`) exists and passes, confirming secrets are not written to logs in plaintext — verified, not assumed.
- **Local model interaction:** the anti-hallucination system prompt and the honest fact/AI-generated separation (§3's second bug, now fixed) are the real security-adjacent property here — not preventing prompt injection in a formal sense, but preventing the *frontend* from lying to the user about what the LLM did or didn't see.
- **What was not verified in this review:** rate limiting was confirmed to exist (`chatRateLimiter` on `/graph/ask`, distinct limiters for auth/import/OAuth in `env.ts`), but its effectiveness against a real, sustained attack was never load-tested. CORS uses an explicit origin allowlist (verified in `app.ts`), not a wildcard — correct, but the actual allowlist contents (`ALLOWED_ORIGINS`) were not inspected against the live deployment as part of this review.

---

## 8. Testing & CI

- **Backend:** 301 test cases across 35 files (verified by direct count, not estimated). Covers unit-level logic extensively (extractors, algorithms, the pipeline's invariant checks) and includes real-MongoDB integration suites for the repository layers.
- **Frontend:** 98 test cases across 17 files (verified by direct count). Meaningfully includes real SSE stream parsing (split-token-across-chunks, malformed-event handling), a genuine integration test wiring the real orchestrator hook to the real component (not just isolated prop-driven rendering), and explicit epistemic-honesty assertions (no forbidden phrase like "evidence used by AI" ever renders).
- **CI:** GitHub Actions, two jobs (`test-api`, `test-web`), both currently green on the real repository — confirmed directly, not assumed, including after the graph feature's new dependencies (React Flow, ELK.js) were added.
- **A real, embarrassing gap found and only partially fixed during this project:** the CI workflow file itself never reached GitHub for the majority of this project's history, due to a packaging bug (an overly broad `.git`-exclude pattern that also matched `.gitignore` and the entire `.github` directory). This means "CI is green" is only a true statement from a specific, recent point in this project's timeline forward — for a long stretch, CI simply never ran at all, and nothing in the project's own documentation caught this until it was checked directly.
- **Browser verification:** extensive, and the single most valuable testing activity in this entire project by outcome — both bugs in §3 were found this way, not by any automated test. But it is entirely manual, unrepeatable, and dependent on a human actually doing it every time.
- **Production smoke testing:** exists (`scripts/smoke-test.ps1`) but is stale — covers only the original register/import/chat flow from Milestone 1, with zero coverage of anything built in Milestone 3 or 3b (graph generation, cycle detection, `/graph/ask`, or any frontend behavior at all, since it's a backend-only PowerShell script).
- **Most important missing coverage, concretely:** an E2E test (even a minimal Playwright script covering login → import → open graph → ask a question) would have caught neither of the two bugs in §3 immediately, but would provide the repeatable regression net that manual browser verification currently cannot.

---

## 9. Interview Readiness

**System design** — Strongest: the layered pipeline (deterministic extraction → versioned, invariant-checked graph → query-time intelligence → routed, mode-aware AI layer) is a genuinely coherent, defensible design with real reasoning behind every boundary. Weakest: no load-tested capacity story — "what happens at 10,000 files" has no answer beyond "the config allows it."
*Be ready for:* "Walk me through what happens when a user asks a question, end to end." "Why is the graph write path a single pipeline with sole write authority?"

**RAG** — Strongest: real vector search with citations, a genuine anti-hallucination system prompt, and — critically — a *frontend* that enforces epistemic honesty structurally (the very bug in §3 that got found and fixed is itself a strong interview story: "we caught our own AI answers being mislabeled, and fixed both the bug and the test gap that let it ship"). Weakest: no retrieval evaluation exists — "how do you know your RAG is good" has an honest but unimpressive answer right now: "we haven't measured it."
*Be ready for:* "How do you prevent the LLM from hallucinating?" "How do you know retrieval quality is good?" (Answer honestly: anti-hallucination prompting and citation-anchoring exist; systematic measurement doesn't yet.)

**Local LLMs** — Strongest: a clean provider interface (`IChatCompletionProvider`) that decouples the rest of the system from the specific model. Weakest: "local" is doing real interpretive work here — Groq is hosted, not on-device — and an interviewer who catches that distinction deserves a precise, honest answer, not a dodge.
*Be ready for:* "Is this actually running locally?" (No — it's a hosted, low-latency inference provider; the architecture would support swapping in a genuinely local model via the same interface, but that swap was never done.)

**Graph algorithms** — Strongest: real Tarjan's SCC, real BFS, both tested against hand-traced cases before being trusted. Weakest: only two algorithms exist; the registry pattern implies more than currently ships.
*Be ready for:* "Walk me through your cycle detection." "Why Tarjan's over a simpler DFS-based approach?"

**Frontend architecture** — Strongest: the Frontend Orchestrator boundary, proven under real pressure (the response-mode-inspection correction), and a design system with a genuinely non-generic, meaningful rationale (the certainty color system). Weakest: zero E2E test automation; every interaction claim in this project rests on manual verification.
*Be ready for:* "How does your frontend know whether to expect a streamed or immediate response?" "Walk me through a real bug you found in the browser that your tests missed, and why."

**Authentication** — Strongest: full rotation + reuse detection, correctly tested including the "session ends entirely" behavior on detected reuse. Weakest: tokens in `localStorage`, a real trade-off worth naming unprompted rather than waiting to be asked.
*Be ready for:* "Why localStorage instead of httpOnly cookies?" (Simpler CORS/deployment for this scope; a real XSS exposure trade-off, acknowledged, not hidden.)

**Security** — Strongest: the anti-enumeration 404 behavior and encrypted-at-rest OAuth tokens are both real, deliberate, verified choices. Weakest: no load-tested rate limiting, no formal threat model beyond what's implemented ad hoc.
*Be ready for:* "How do you prevent a user from discovering another user's private repository exists?"

**Scalability** — Strongest: the graph's versioned immutability and the pipeline's invariant-checking mean correctness scales even if performance is unmeasured. Weakest: this is the single least-prepared area of the whole project — no benchmarks, no load tests, no capacity plan.
*Be ready for:* "What happens with a 10,000-file repository?" (Config allows it; nothing has verified it actually works well.)

**Failure handling** — Strongest: SSE interruption handling is real and tested (partial output preserved, never silently discarded), and the import pipeline correctly records failure without corrupting the graph. Weakest: no durability/resume story for a crash mid-import — a genuine, named gap, not a hidden one.
*Be ready for:* "What happens if the import process crashes halfway through?" (Honest answer: it fails cleanly, but there's no resume — has to restart from scratch. This is documented as the top item of technical debt, not discovered live.)

---

## 10. Milestone 4 Recommendation

**Objective:** close the credibility gap between "the system works" (extensively verified) and "the system is production-grade" (largely unverified) — specifically, retrieval evaluation, E2E testing, and job durability, the three items most likely to come up as direct follow-up questions to everything demonstrated in Milestone 3b.

**Why it matters:** every strength identified in §9 has a corresponding, honestly-named weakness. Milestone 4 should convert the weakest of those into strengths rather than add new surface area — a broader project with the same gaps is a worse interview story than a narrower one without them.

**Tasks (max 6):**

1. **Retrieval/classification evaluation harness** — a small, real golden-question set (10–20 questions per repository, spanning all four routing categories) with pass/fail or scored grading, run against a couple of real imported repositories. Turns "we haven't measured it" into an actual number.
2. **Job durability for repository import** — at minimum, a resumable job state so a crash mid-import doesn't require starting over. The longest-standing Critical debt item in this project.
3. **A minimal E2E test** (Playwright or similar) covering exactly the demo chain already built: login → import → open graph → select a node → ask both a Pure Graph and a Hybrid question. Would not need to be exhaustive — even this one flow, automated, closes the single largest testing gap named in §8.
4. **Update the smoke test** to cover graph generation and `/graph/ask`, not just the Milestone 1 flow — cheap, and directly addresses a real, embarrassing, already-discovered gap.
5. **A basic load/capacity check** — import one deliberately large repository (near the `MAX_REPO_FILES` ceiling) and record real numbers: import time, graph size, frontend render performance. Doesn't need to drive optimization work yet — just needs to replace "unmeasured" with "measured and here's the number."
6. *(Optional, lower priority)* Address the inferred-tier classification accuracy gap, but only using the evaluation harness from Task 1 — not by hand-tuning against the single known klona anecdote.

**Expected interview value:** directly converts three of the weakest answers in §9 (RAG evaluation, E2E testing, failure handling) into strong ones, without touching anything already working.

**Dependencies:** Task 1 should come before Task 6, if Task 6 is attempted at all. Tasks 2–4 are independent of each other and of Task 1.

**Risks:** Task 2 (job durability) is the most architecturally invasive of the six — it touches the import pipeline's execution model, not just its output, and deserves its own design-review pass before implementation, matching how Milestone 2's OAuth work was handled. Task 5's "large repository" test could itself surface a real performance problem with no immediate fix available within the milestone — worth scoping the milestone to *measuring and reporting* that number, not necessarily *solving* whatever it reveals.

---

*End of review. Awaiting confirmation before any further work begins.*
