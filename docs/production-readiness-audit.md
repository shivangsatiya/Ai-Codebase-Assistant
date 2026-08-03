# Production Readiness Audit — AI Codebase Assistant

**Reviewer stance:** Principal Engineer, production-readiness review, as if approving this for a small internal developer platform before more people touch it.
**Scope:** Everything built through Milestone 1, Day 5 (auth, repo import/parsing/chunking/embedding, chat/retrieval).
**Method:** Every claim below was checked against the actual repository, not inferred from the design doc. Several things below contradict what the original SDD assumed — that drift is itself a finding (see §2).

---

## STEP 1 — PROJECT AUDIT

### Current Architecture

Layered monolith, single Express process:

```
Route → Middleware (auth, validation) → Service (business logic) → Repository (data access) → Mongoose → MongoDB Atlas
                                       ↘ Client (external system: GitHub, git CLI, local ML model, Groq)
```

A `config/composition-root.ts` builds every shared singleton once (repositories, clients, services) and every route file imports from it. This is not what the project started with — `repository.routes.ts` originally constructed its own dependencies inline; the composition root was introduced specifically once a second consumer (chat) needed to share the embedding model instance without loading it twice. That's a real, motivated refactor, not upfront over-engineering — worth being able to say exactly that in an interview.

**What's implemented well:** the layering is consistently applied — no route file touches Mongoose directly, no service imports Express types. That consistency, held across five days and three provider swaps, is the actual signal of a real architecture rather than a diagram that stopped matching the code.

**What's missing:** there is no `application` vs `domain` distinction beyond what "services" already are — fine at this scale, would need revisiting if business rules got substantially more complex (e.g., multi-step workflows spanning several services with their own invariants).

**What should be improved:** the composition root is a single file constructing everything at module-load time. That's simple and works, but it means "which concrete implementation is wired to which interface" is discoverable only by reading one file — there's no way to override a binding per-environment (e.g., a staging config using a cheaper model) without editing that file directly. Acceptable for one deployment target; would need a small config-driven factory if this ever supported multiple environments with different provider choices.

**Why it matters in production:** a composition root that's easy to read is what makes onboarding a new engineer to "where does X actually get its Y" fast. That's real, not performative — but it also means the composition root itself has zero tests, because it's wiring, not logic. Worth naming that limitation rather than pretending it's covered.

---

### Current Folder Structure

```
apps/api/src/
├── clients/        external system wrappers (GitHub, git, local embeddings, Groq)
├── config/         env validation, DB connection, composition root
├── middleware/      auth, validation, error handling, request logging
├── models/         Mongoose schemas
├── parsing/         tree-sitter language registry, AST chunker, line-window fallback
├── repositories/    data access, one file per aggregate (user, repository, chunk, chat)
├── routes/         thin HTTP layer + per-route Zod schemas
├── services/        business logic
├── types/           ambient type augmentation
└── utils/           errors, logger, file walker
```

**What's implemented well:** one concept per file, consistent naming (`X.service.ts`, `X.repository.ts`, `X.client.ts`, `X.schemas.ts`). A reviewer can predict where anything lives without grep.

**What's missing:** no `interfaces/` or `types/` folder for the various `I*` interfaces scattered across `clients/` and `repositories/` — they live next to their primary implementation, which is fine for one implementation but means "list every port this system depends on" isn't a single directory listing.

**What should be improved:** nothing urgent. This is a reasonable structure for the current size (roughly 40 source files). It would start to strain past maybe 100-150 files, at which point feature-based folders (`features/auth/`, `features/repository-import/`) would likely read better than layer-based ones — not a change worth making now.

---

### Design Patterns Used

| Pattern | Where | Assessment |
|---|---|---|
| Repository pattern | `IUserRepository`, `IRepositoryRepository`, `IChunkRepository`, `IChatRepository`, `IMessageRepository` | Consistently applied; every Mongoose call is behind an interface |
| Dependency Injection (constructor) | Every service | Manual, no DI container/framework — appropriate at this scale; a container (InversifyJS, tsyringe) would be premature complexity for ~10 injectable services |
| Strategy pattern | `IEmbeddingProvider`, `IChatCompletionProvider` | This is the strongest pattern in the codebase — proven three times over by actually swapping implementations (Voyage → OpenAI → local; Claude → Groq) without touching business logic |
| Composition root | `config/composition-root.ts` | Correct pattern, but see the limitation noted in §1 (Architecture) |
| Fail-fast configuration | `config/env.ts` | Zod-validated env, process exits on invalid config rather than failing on first request |

**What's missing:** no explicit use of the Factory pattern anywhere a provider needs environment-conditional construction (currently just an `if` inside the composition root — fine at 2-3 providers, would want a real factory past that).

**Why it matters:** the Strategy pattern payoff here is the single most defensible engineering claim in the project — "I designed for provider swaps and then was actually forced to prove it, three times, under real account failures" is a stronger interview answer than most candidates can offer, because it's verifiably true rather than a design-doc aspiration.

---

### Dependency Graph

```
routes/ ──depends on──> config/composition-root (concrete singletons)
services/ ──depends on──> repositories/ (interfaces), clients/ (interfaces)
repositories/ ──depends on──> models/ (Mongoose schemas)
clients/ ──depends on──> external systems (GitHub API, git CLI, ONNX runtime, Groq API)
```

**What's implemented well:** `services/` never imports `mongoose` directly — every DB access goes through a repository interface. Verified: `grep -r "from 'mongoose'" src/services/` returns nothing.

**What's missing / should be improved:** routes import concrete singleton instances from the composition root rather than interfaces (`import { chatOrchestrationService } from '../config/composition-root'`). This is a mild Dependency Inversion violation at the route layer specifically — routes depend on a concrete wiring module, not an abstraction. It's a defensible, common pragmatic choice (a "poor man's service locator"), but it does mean route-level unit tests (as opposed to service-level ones, which are well covered) aren't really possible without hitting real infrastructure. This is why the test suite has strong service-level coverage and only smoke-level route coverage (auth-required checks) rather than full route-level behavior tests.

**Why it matters:** this is a real, honest trade-off, not a bug — but worth being able to name precisely if asked "why don't you have route-level integration tests for the chat flow?"

---

### Data Flow

**Synchronous request (auth, GET status):** HTTP → middleware chain → route → service → repository → Mongoose → response.

**Async pipeline (repository import):** HTTP request returns `202 Accepted` immediately with a job id; the actual clone → walk → parse → chunk → embed → store pipeline runs "fire and forget" inside the same Node process, not a separate worker. Status is polled via `GET /api/repositories/:id`.

**Streaming (chat):** HTTP request stays open; tokens are written directly to the response as Server-Sent Events as they arrive from Groq; the connection closes when the stream ends or the client disconnects.

**What's implemented well:** the async-with-polling pattern for import is the right shape for a single-process app and was explicitly designed to be replaceable by a real job queue later (documented in the code comments) without changing the client-facing contract.

**What's missing:** **if the Node process crashes or restarts while an import is mid-flight, the job is silently abandoned** — its status stays at whatever stage it was in (`cloning`, `parsing`, `embedding`) forever, with no reconciliation on startup. This is the single most significant reliability gap in the whole system, more important than anything else in this audit.

**Why it matters in production:** a stuck job with no automatic recovery is exactly the kind of thing that looks fine in a demo and becomes a support ticket in real usage. Worth fixing before anything else in the hardening plan (see §3, Task 1).

---

### AI Pipeline

`walkRepoFiles` → `ChunkingService` (AST-first via tree-sitter, line-window fallback) → `LocalEmbeddingClient` → `MongoChunkRepository`.

**What's implemented well:** the AST-vs-fallback decision, the gap-filling logic (so imports/constants outside any function aren't silently dropped), and the idempotency guarantee (`repositoryId + commitSha + contentHash` unique index) are all genuinely non-obvious engineering decisions with documented rationale in the code itself. This is the strongest technical section of the project.

**What's missing:** chunking runs synchronously, file-by-file, on the main thread. `LocalEmbeddingClient`'s inference is CPU-bound and also runs on the main thread — for a repo large enough to matter, this blocks the Node event loop, meaning **the server cannot serve any other request (including an unrelated chat query) while an import is embedding.** This is real, verified: nothing in `LocalEmbeddingClient` or the ONNX runtime configuration uses `worker_threads`.

**What should be improved:** move embedding inference to a worker thread pool, or at minimum benchmark whether this is actually a problem at portfolio scale (a few hundred chunks) before spending engineering time on it — this is the right kind of thing to measure before fixing.

**Why it matters:** "the whole server hangs while indexing" is a believable, concrete failure mode to describe and fix — a much better interview story than an abstract "we should use worker threads" statement.

---

### Repository Indexing Pipeline

`GitHubClient` (validate) → `GitClonerClient` (shallow clone to isolated temp dir) → `walkRepoFiles` (extension allowlist, size/count ceiling) → `ChunkingService` → `LocalEmbeddingClient` → `MongoChunkRepository.insertManyIdempotent` → cleanup.

**What's implemented well:** isolation (fresh temp dir per job, cleaned up in a `finally`), input validation before any expensive work starts (GitHub API check, then size/count ceiling during the walk), and idempotent storage. Three real, separate production concerns, all actually handled.

**What's missing:** no retry on transient clone failures (a flaky network blip during `git clone` fails the whole import with no retry, unlike the (now-removed) embedding provider's retry logic). No timeout on the clone step itself — a hung `git clone` (e.g., against a slow or malicious host) could tie up a job indefinitely. GitHub token is optional, which is the right call for zero-friction setup, but means the default experience is still subject to a 60/hour cap shared across your whole network — worth surfacing that limitation more visibly to a new user than a code comment.

**Why it matters:** clone failures and hangs are the most likely real-world failure mode of this specific pipeline (network flakiness is common; malformed embeddings are rare). This is worth fixing before something more exotic.

---

### RAG Pipeline

`RetrievalService` (embed query, `$vectorSearch` scoped by `repositoryId`) → `ChatOrchestrationService` (system prompt construction, streaming, citation extraction, message persistence).

**What's implemented well:** the anti-hallucination system prompt design (explicit instruction to say "I don't know" rather than guess, explicit instruction to never invent a citation — the latter added specifically after a real observed failure, not preemptively) and the interface boundary between retrieval and generation are both solid, demonstrable decisions.

**What's missing:** no re-ranking of retrieved chunks beyond what `$vectorSearch`'s cosine similarity already provides — for a general-purpose embedding model (not code-specific), a cheap re-ranking pass (e.g., boosting exact identifier matches) would likely improve precision meaningfully. No evaluation harness at all — there's no way to measure "did retrieval actually find the right chunk" other than manually reading an answer, which doesn't scale past a demo.

**Why it matters:** "I built RAG" is not differentiated; "I built RAG and then measured whether retrieval quality was actually good, and improved it based on that measurement" is. This is the single highest-leverage addition available for AI-engineering interview credibility (see §3).

---

### Authentication Readiness

JWT access (15m) + refresh (7d) tokens are issued on register/login. **The refresh token is issued and returned to the client, but there is no endpoint anywhere that accepts and validates it.** Verified: no route matches `/refresh` anywhere in `routes/`. This is an incomplete feature, not a stylistic gap — right now, once a 15-minute access token expires, the only option is logging in again; the refresh token is dead weight in the response payload.

**What's implemented well:** password hashing (bcrypt, configurable cost factor), stateless verification (no session store), and — a detail worth being proud of — login intentionally returns the identical error for "no such user" and "wrong password," preventing user enumeration.

**What's missing:** the refresh flow (as above); no logout/token revocation (a stolen access token is valid until it naturally expires — 15 minutes is a deliberately short window, which somewhat mitigates this, but there's no way to force-invalidate one early); no rate limiting on login/register (see Security below); no password reset flow (reasonable to skip for a portfolio project, but worth naming as intentionally out of scope rather than forgotten).

**Why it matters:** an unused refresh token is the kind of gap that's invisible until someone asks "so what happens after 15 minutes?" — which is exactly the kind of question an interviewer asks.

---

### Error Handling

Centralized `errorHandler` middleware; `AppError` class hierarchy (`ConflictError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `RateLimitedError` — the last one defined but currently unused, since nothing rate-limits yet); specific recognition of Mongoose `CastError` and `body-parser`'s malformed-JSON `SyntaxError`, both added after real bugs surfaced them, not anticipated in advance.

**What's implemented well:** the pattern of "recognize a specific non-`AppError` failure mode, translate it explicitly" was applied twice for real bugs found during development — that's the pattern working as designed, not just present in the code.

**What's missing:** no global `process.on('uncaughtException')` / `process.on('unhandledRejection')` handlers — an unexpected synchronous throw outside Express's request cycle (rare, but possible, e.g., inside the "fire and forget" import pipeline's unawaited promise chain) could crash the process silently or leave it in an undefined state. No circuit breaker or bulkhead pattern around external dependencies (GitHub API, Groq) — a slow or hanging Groq response has no timeout, meaning a single hung request could hold an SSE connection open indefinitely.

**Why it matters:** the import pipeline already logs unhandled errors in its own `.catch()` (good), but that's a per-call-site pattern, not a safety net for the whole process. A single process-level handler is cheap insurance against the failure mode "we didn't think of this specific edge case."

---

### Logging

Structured JSON logging via `pino` + `pino-http`, request-id correlation, pretty-printing in development.

**What's implemented well:** every request logs a single structured line with method, URL, status, and latency; errors are logged with full detail server-side while the client only sees a sanitized message.

**What's missing — a real, verified issue:** **`pino-http` is configured with no redaction at all.** The `Authorization: Bearer <token>` header is logged in full, in plaintext, on every request. This was directly observable in this project's own development logs. In a real deployment, this means every access token that's ever been used shows up verbatim in log storage — a genuine credential-leakage surface if logs are ever shipped anywhere (a log aggregator, a support ticket, a screenshot).

**Why it matters:** this is the single highest-priority fix in this entire audit. It's a two-line change (`pino`'s `redact` option) with real security consequence if skipped. See §3, Task 2.

---

### Configuration Management

Zod-validated environment schema (`config/env.ts`), fail-fast at startup, `.env.example` documented with inline rationale for non-obvious defaults (e.g., why `BCRYPT_SALT_ROUNDS` has a minimum, why the repo-size ceiling exists).

**What's implemented well:** genuinely one of the stronger parts of the project — the env schema has caught real bugs during development (a missing var during testing failed loudly and immediately, exactly as designed).

**What's missing:** no distinction between vars required only in production vs. development (e.g., `GITHUB_TOKEN` is optional everywhere, which is fine, but there's no schema-level concept of "required in prod, optional in dev" for anything that might need it later). No secrets manager integration — acceptable at this scale (plain env vars via Render's dashboard are a normal, legitimate choice for a project this size), but worth being able to say explicitly that this is a scale-appropriate choice, not an oversight.

---

### Environment Variables

Fourteen variables across server config, DB, JWT, bcrypt, local embeddings, GitHub, Groq, and retrieval tuning — all documented in `.env.example` with comments explaining *why*, not just what.

**What's implemented well:** this is unusually good for a portfolio project — most `.env.example` files are just a list of names; this one explains trade-offs inline (e.g., why the repo-size ceiling exists, why `GITHUB_TOKEN` is optional but recommended).

**What's missing:** nothing structurally; the one thing worth double-checking periodically is that `.env.example` stays in sync as vars get added (it has, so far, but this is a "keep doing this" note, not a gap).

---

### Security

| Concern | Status |
|---|---|
| Password hashing | ✓ bcrypt, configurable cost |
| JWT verification | ✓ implemented correctly, rejects refresh tokens presented as access tokens |
| Input validation | ✓ Zod at every route boundary |
| Ownership checks | ✓ 404-not-403 pattern applied consistently (repositories, chats) |
| Helmet (security headers) | ✓ enabled with defaults |
| **CORS** | ✗ `cors()` called with no options — **allows any origin**, verified in `app.ts` |
| **Rate limiting** | ✗ **completely absent** — verified, no `express-rate-limit` or equivalent anywhere in the codebase or `package.json` |
| Log redaction | ✗ **Authorization headers logged in plaintext** (see Logging above) |
| Refresh token revocation | ✗ not implemented (see Authentication above) |
| NoSQL injection | Mostly mitigated by Mongoose's schema typing (all inputs are validated/typed before reaching a query), not independently audited |
| Secrets in source | ✓ none found — `.env` is gitignored, all secrets are environment-provided |

**Why the two ✗ items marked "real" matter most:** wide-open CORS is low-risk *today* (no cookies, no credentialed requests, a Bearer-token API), but it's the kind of default that becomes a real problem the moment anyone adds cookie-based auth or a browser extension integration without revisiting it. Absent rate limiting is a direct cost and abuse vector: `/api/auth/login` and `/api/auth/register` are wide open to brute-force/credential-stuffing attempts, and `/api/repositories` (which triggers a real clone + CPU-bound embedding job) can be hit repeatedly by anyone with a valid token, for free, as fast as they can send requests.

---

### Performance

No caching layer (Redis or otherwise) anywhere — every chat question re-embeds the query and re-runs `$vectorSearch`, even for a repeated or near-identical question. No connection pool tuning documented for Mongoose (using defaults, which are reasonable but unexamined). Local embedding inference and file chunking both run on the main thread (see AI Pipeline above).

**What's implemented well:** the things that *are* optimized were optimized for the right reason — idempotent chunk storage avoids re-embedding identical content on re-import, and the file walker rejects oversized repos before spending any compute on them.

**What's missing:** there's no evidence anywhere in the codebase that latency or throughput has been measured under any load. Every performance claim in this audit (main-thread blocking, no caching) is a structural observation, not a benchmarked one.

**Why it matters:** "we should add caching" is weak; "we measured that repeated queries cost N ms each and cached the embedding step, cutting P95 latency by X%" is strong. Nothing here should be optimized before it's measured (see §3).

---

### Scalability

Single Node process; import pipeline runs in-process rather than via a real job queue (BullMQ, as the original design doc anticipated for a later milestone); `LocalEmbeddingClient` loads a model into the memory of whichever process constructs it — running N instances behind a load balancer would load the model N times, with no shared cache.

**What's implemented well:** the code was written with this limitation in mind — the import service's doc comments explicitly note that swapping the in-process "fire and forget" call for a real queue later shouldn't require changing the request/response contract. That's a real, deliberate design-for-extension, not an afterthought.

**What's missing:** the actual queue. This project cannot currently run more than one server instance without either (a) duplicating the embedding model's memory footprint per instance, or (b) extracting embeddings into a separate service. Neither is wrong at this project's current scale — but it's worth being explicit that "designed to be extended" and "already scales" are different claims, and only the first one is true today.

---

### Testing

53 tests passing across 8 suites at last count, covering: AST chunking (JS/TS/Python), line-window fallback, the local embedding client (via an injected fake, no real model download needed), auth service logic (fake repository), chat prompt construction and citation extraction (pure functions), retrieval service (fake embedding provider + fake chunk repo), chat orchestration (fake chat/message repos, fake retrieval, fake LLM), and the file walker (real filesystem, real temp directories).

Two additional suites require a real MongoDB connection (`auth.routes.test.ts`, `chunk.repository.test.ts`) and could not be run inside this development sandbox specifically (its network restrictions block the `mongodb-memory-server` binary download) — they're written and type-checked, and were previously confirmed passing on the actual development machine.

**What's implemented well:** the dependency-injection pattern applied throughout the codebase pays for itself directly here — nearly every piece of business logic is tested via a fake, with zero real network calls, zero real database, and zero real ML inference required to prove the logic is correct. This is genuinely strong test architecture, not just test *coverage*.

**What's missing:** no test at all for `$vectorSearch` itself (structurally impossible with `mongodb-memory-server`, which doesn't support Atlas Search — a real, named, and documented limitation, not an oversight); no route-level integration test for the full chat SSE flow (a consequence of the composition-root pattern noted in §1); no load or concurrency tests; the CI workflow (`ci.yml`) exists and should work as written (it doesn't need real secrets, since the test environment fabricates all required env vars), but **has never actually been run against a real GitHub Actions execution during this project** — it's unverified, not necessarily broken.

**Why it matters:** "I have tests" is unconvincing on its own; "I have tests specifically designed around the parts of the system that don't require expensive infrastructure, and I can tell you exactly which two things I can't test that way and why" is a materially stronger answer.

---

### Documentation

`README.md` narrates real engineering decisions with genuine "why," not just "what" — including two real bugs found in production-adjacent testing (the Mongoose index-timing race, the object-spread bug in Mongoose's own `insertMany` error handling) and the provider-swap history (Voyage → local embeddings; Claude → Groq) with honest reasoning for each.

**What's implemented well:** this is unusually good. Most portfolio READMEs describe features; this one describes decisions and trade-offs, which is what actually gets discussed in interviews.

**What's missing — and this is a real, significant finding:** **the original Software Design Document (SDD) is now stale relative to the actual implementation.** It specifies Voyage AI embeddings and Claude for chat; the real system runs local embeddings and Groq. Anyone comparing the SDD to the code would find real drift on two of the most consequential technology decisions in the project. This isn't a documentation nitpick — a design doc that doesn't match reality actively undermines the credibility of the rest of the document if a reviewer notices it first.

No OpenAPI/Swagger spec exists for the API surface. No architecture diagram lives in the repository itself (the SDD has Mermaid diagrams, but they describe the stale architecture per the point above).

**Why it matters:** the fix here is cheap (update the SDD's tech stack section and diagrams to match reality, note the provider-swap history as a design decision rather than silently updating it) and the cost of not fixing it (a reviewer catching the drift) is disproportionately high relative to the effort to fix it.

---

## STEP 2 — GAP ANALYSIS vs. Original Software Design Document

| Feature | Current Status | Missing Pieces | Priority | Est. Effort | Interview Value |
|---|---|---|---|---|---|
| GitHub OAuth | Not started | Entire flow (Milestone 2 per original plan) | Medium | 3-4 days | Medium — standard OAuth, well-understood pattern |
| Private repositories | Not started | Requires GitHub OAuth first (token scoping) | Medium | 2-3 days (after OAuth) | Medium |
| Architecture Visualizer | Not started | Entire feature | Low (for now) | 1-2 weeks | High — most visually differentiating feature, but only worth it once the core is hardened |
| Streaming responses | Done | — | — | — | Already a strong talking point (SSE, token-by-token, graceful mid-stream error handling) |
| Rate limiting | Not implemented | Everything — this is a real, verified gap | High | 0.5-1 day | High — cheap to add, directly addresses a real gap this audit found |
| Retry mechanisms | Partial | Present for the (now-removed) rate-limited embedding provider's pattern; absent for git clone, GitHub API calls, Groq calls | Medium | 1 day | Medium |
| Caching | Not implemented | No caching layer anywhere | Medium | 1-2 days | Medium-High if tied to a measured latency win |
| Processing jobs | Partial | In-process only, no persistence/resume on crash (see §1, Data Flow) | High | 2-3 days for a real queue | High — this is the most concrete scalability story available |
| Dependency analysis | Not started | Entire feature | Low | 3-5 days | Medium |
| README generation | Not started | Entire feature | Low | 2-3 days | Medium |
| Documentation generation | Not started | Entire feature | Low | 3-4 days | Medium |
| Security review (as a feature) | Not started | Entire feature | Low | 4-5 days | Medium-High (ironic given this audit) |
| Unit test generation | Not started | Entire feature | Low | 3-4 days | Medium |
| Refactoring suggestions | Not started | Entire feature | Low | 3-4 days | Medium |
| API documentation (as a feature) | Not started | Entire feature | Low | 2-3 days | Low-Medium |
| Dead code detection | Not started | Entire feature | Low | 3-4 days | Medium |
| Architecture explanation (as a feature) | Not started | Entire feature | Low | 2-3 days | Medium |

**Read on this table:** almost everything in the "AI action" category (README gen, dead code detection, refactor suggestions, etc.) is *unstarted*, and that's the correct state for a project that made the deliberate, documented choice to build one feature (chat) to production depth rather than many features shallowly. The gap analysis's real message isn't "there's a lot missing" — it's "the two highest-priority gaps (rate limiting, job durability) are both about making the *existing* feature production-solid, not about building new ones." That should drive the roadmap in §3, not the feature list.

---

## STEP 3 — PRODUCTION HARDENING PLAN (Milestone 1.5)

Ordered so every step leaves the project in a working, demoable state. Each task is independent — stopping after any one of them is a coherent place to pause.

### Task 1 — Redact secrets from logs

**Status: ✅ Complete.** Implemented in `src/utils/logger.ts` (the `REDACTED_PATHS` export), verified both manually and via `tests/logger-redaction.test.ts`. See the README's Milestone 1.5 section for the full account.

**Purpose:** stop logging `Authorization` headers (and any other bearer tokens) in plaintext.
**Engineering rationale:** this is the highest-severity, lowest-effort fix in the entire audit — a credential-leakage surface with a two-line fix.
**Files affected:** `src/middleware/request-logger.ts`.
**Difficulty:** Trivial.
**Estimated time:** 15 minutes.
**Expected outcome:** logs show `"authorization": "[Redacted]"` instead of the real token.
**Potential pitfalls:** pino's `redact` option uses path syntax (`req.headers.authorization`) — easy to get the path wrong and redact nothing; verify by triggering a real authenticated request and reading the log line.
**How to test it:** make an authenticated request, grep the resulting log line for the literal token string — it should not appear.
**Interview talking points:** "I audited my own logging output and found I was leaking bearer tokens in plaintext — here's the fix and here's how I verified it" is a concrete, specific security story.

---

### Task 2 — Add rate limiting

**Status: ✅ Complete.** Implemented in `src/middleware/rate-limit.ts`, wired into `auth.routes.ts` (IP-based), `repository.routes.ts` and `chat.routes.ts` (user-based, after `requireAuth`). A real additional finding surfaced during implementation and was fixed alongside it: `trust proxy` was never configured, which would have made IP-based limiting silently useless behind Render's reverse proxy. Verified with runtime tests (`tests/rate-limit.test.ts`) against the real library, not just type-checked. See the README's Milestone 1.5 section for the full account, including a second bug (a test-suite interaction) caught and fixed via self-review before shipping.

**Purpose:** protect `/api/auth/login`, `/api/auth/register` from brute force/credential stuffing, and `/api/repositories`, `/api/chats/:id/messages` from cost-abusive spam (each triggers real compute or a real external API call).
**Engineering rationale:** currently zero rate limiting exists anywhere — verified by grep. This was flagged as a design-doc non-functional requirement from Day 1 and never implemented.
**Files affected:** new `src/middleware/rate-limit.ts`; wired into `app.ts` or per-route in `auth.routes.ts` / `repository.routes.ts` / `chat.routes.ts`.
**Difficulty:** Low.
**Estimated time:** Half a day, including tests.
**Expected outcome:** a stricter limit on auth endpoints (e.g., 5 attempts/15 min per IP) and a looser one on import/chat (e.g., 20/hour per user).
**Potential pitfalls:** `express-rate-limit`'s default in-memory store doesn't work correctly across multiple processes/instances — fine for this project's current single-instance deployment, but worth a code comment noting it'd need a Redis store if this ever scaled horizontally.
**How to test it:** an integration test hammering an endpoint past its limit and asserting a `429`.
**Interview talking points:** ties directly to the "designed for extension, not yet scaled" honesty from §1 — you can describe exactly what would need to change (a shared store) if this had to run on more than one instance.

---

### Task 3 — Job durability: reconcile stuck imports on startup

**Purpose:** detect and recover repository-import jobs left in a non-terminal state (`cloning`, `parsing`, `embedding`) by a crashed or restarted process.
**Engineering rationale:** the single most significant reliability gap found in this audit (§1, Data Flow).
**Files affected:** `src/config/db.ts` or a new `src/jobs/reconcile-stuck-jobs.ts`, run once at startup after `connectDB()`.
**Difficulty:** Medium.
**Estimated time:** 1 day.
**Expected outcome:** on startup, any job stuck in a non-terminal state for longer than some threshold (e.g., 10 minutes) is marked `failed` with a clear `errorMessage` ("Import was interrupted by a server restart"), rather than silently hanging forever.
**Potential pitfalls:** need to be careful not to mark a *genuinely still-running* job as failed if the reconciliation logic runs on every restart including graceful ones — use a timestamp-based threshold, not just "is it non-terminal."
**How to test it:** seed a job in `embedding` state with an old `updatedAt`, restart the reconciliation logic, assert it flips to `failed`.
**Interview talking points:** this is the project's best "designed for the failure mode that would actually happen in production" story — a full job queue (BullMQ) is the "correct" long-term answer, but a simple reconciliation pass is the honest, right-sized fix for a single-process app today, and you can articulate why you didn't reach for the heavier tool first.

---

### Task 4 — Restrict CORS

**Status: ✅ Complete.** Implemented via `env.ALLOWED_ORIGINS`, wired into `app.ts`'s `cors()` call. Verified with a dedicated test suite checking actual response headers, since CORS enforcement itself is browser-side and can't be tested via this project's usual HTTP-client verification steps. See the README's Milestone 1.5 section for the full account.

**Purpose:** stop allowing every origin by default.
**Engineering rationale:** low risk today (no cookie-based auth), but a bad default to leave unexamined.
**Files affected:** `src/app.ts`, one new env var (`ALLOWED_ORIGINS`).
**Difficulty:** Trivial.
**Estimated time:** 30 minutes.
**Expected outcome:** `cors({ origin: env.ALLOWED_ORIGINS.split(',') })`, defaulting to `http://localhost:*` in development.
**Potential pitfalls:** breaking your own frontend if you forget to add its origin once one exists.
**How to test it:** a request from a disallowed origin should be rejected by the browser (can't easily test via `curl`/PowerShell, since CORS is browser-enforced — note this limitation rather than writing a misleading test).
**Interview talking points:** minor, but shows the habit of not leaving a permissive default unexamined.

---

### Task 5 — Add a real health/readiness check

**Status: ✅ Complete.** Split into `/health/live` and `/health/ready` in `app.ts`, the latter checking `mongoose.connection.readyState`. Verified with a test that deliberately disconnects the real database to prove the check reflects actual state, not just the happy path. See the README's Milestone 1.5 section for the full account, including a real break (a stale test reference to the old `/health` path) caught before it shipped.

**Purpose:** `/health` currently returns `{status: "ok"}` unconditionally — it doesn't verify the database connection is actually alive.
**Engineering rationale:** a liveness check that always passes is not useful for detecting a real outage (e.g., Mongo connection dropped but the Node process is still up).
**Files affected:** `src/app.ts`.
**Difficulty:** Trivial.
**Estimated time:** 30 minutes.
**Expected outcome:** `/health` checks `mongoose.connection.readyState` and returns `503` if not connected.
**Interview talking points:** the distinction between liveness and readiness checks is a real production concept worth being able to explain precisely.

---

### Task 6 — Implement the refresh token endpoint (or remove it)

**Status: ✅ Complete — implemented (not removed).** Built as rotation with reuse detection, including a `logout` endpoint as a near-free byproduct of the same infrastructure. See the README's Milestone 1.5 section for the full account, including two real bugs self-review caught before shipping.

**Purpose:** the refresh token is currently issued but has no corresponding endpoint — either finish the feature or stop issuing a token nobody can use.
**Engineering rationale:** an unused credential in a response payload is either a bug (forgot to build the endpoint) or dead code (decided not to need it) — right now it reads as the former.
**Files affected:** `src/routes/auth.routes.ts` (new `POST /refresh`), `src/services/auth.service.ts` (new method validating a refresh token and issuing a new access token).
**Difficulty:** Low-Medium.
**Estimated time:** Half a day, including tests.
**Expected outcome:** either a working `/api/auth/refresh` endpoint, or refresh tokens removed from the response entirely with a note on why.
**Interview talking points:** whichever direction you go, being able to explain the decision (not just the code) is what matters here.

---

### Task 7 — Sync the SDD with reality

**Purpose:** the original design doc still describes Voyage + Claude; the real system runs local embeddings + Groq.
**Engineering rationale:** documentation drift on the two most consequential technology decisions undermines the credibility of the whole document to anyone comparing it against the code.
**Files affected:** the SDD markdown file's tech stack table and architecture diagrams.
**Difficulty:** Trivial (writing), but requires care to preserve the *history* (why the switch happened) rather than just silently updating the table as if Voyage/Claude were never chosen.
**Estimated time:** 1-2 hours.
**Expected outcome:** the SDD reads as "here's what we chose, here's what we learned, here's what we're actually running" rather than a stale snapshot.
**Interview talking points:** a design doc that honestly documents its own revision history is more credible than one that pretends to have been right the first time.

---

### Task 8 — Add a basic retrieval evaluation harness

**Purpose:** there is currently no way to measure whether `$vectorSearch` is actually retrieving the right chunks for a given question, beyond manually reading an answer.
**Engineering rationale:** this is the single highest-leverage addition for AI-engineering credibility specifically — it's the difference between "I built RAG" and "I built RAG and measured it."
**Files affected:** a new `scripts/` or `tests/` harness — a small set of (question, expected file) pairs for a known test repo, checking whether the expected file appears in the top-K retrieved chunks.
**Difficulty:** Medium.
**Estimated time:** 1 day.
**Expected outcome:** a repeatable "retrieval@k" measurement you can quote a real number for.
**Potential pitfalls:** needs a stable test repo and hand-labeled ground truth — resist the urge to make this bigger than it needs to be; 10-15 question/answer pairs is enough to be meaningful.
**How to test it:** it *is* the test.
**Interview talking points:** this is worth more in an interview than most of the unstarted "AI action" features in §2 combined, because it demonstrates measurement discipline, not just feature-building.

---

## STEP 4 — CODE QUALITY REVIEW

**Code smells found:**
- `repository.routes.ts`'s `POST /:id/chats` handler duplicates the ownership-check logic (find repo → check `ownerId` → 404 if mismatched) that also appears in `GET /:id`. Small, worth extracting into a shared `getOwnedRepositoryOrThrow(id, userId)` helper — not urgent, but a clear DRY opportunity.
- `RateLimitedError` class is defined in `utils/errors.ts` but currently unused anywhere — dead code until Task 2 above lands, at which point it becomes live.

**SOLID assessment:**
- **SRP:** well respected — `ChunkingService`, `RetrievalService`, `ChatOrchestrationService` each do one clearly-named thing.
- **OCP:** the strongest example in the codebase — `IEmbeddingProvider` and `IChatCompletionProvider` allowed three provider swaps with zero changes to the services that depend on them. This is OCP demonstrated under real pressure, not just claimed.
- **LSP:** no violations found — every interface implementation is fully substitutable.
- **ISP:** `IChunkRepository` mixes read concerns (`countByRepository`, `vectorSearch`) with a write concern (`insertManyIdempotent`) in one interface. Not wrong at this scale, but a CQRS-style split (`IChunkReader` / `IChunkWriter`) would be the "more correct" answer if this interface grew much larger — naming it now, not fixing it now.
- **DIP:** mostly respected within `services/`; the route layer's direct import of concrete composition-root singletons (see §1, Dependency Graph) is the one place DIP is loosened, for pragmatic reasons worth being able to name explicitly rather than defend as if it weren't a trade-off.

**Naming, coupling, duplication:** no significant issues found. Function and file naming is consistent throughout. No large functions (the longest, `RepositoryImportService.runImportPipeline`, is long because it orchestrates a multi-stage pipeline — it's already been kept to orchestration only, with each stage's actual logic delegated to a dedicated class).

**Missing abstractions:** none found that would clearly pay for themselves at the current scale. The temptation to add more abstraction (a generic "Pipeline" base class, a formal Job Queue abstraction ahead of actually needing one) would be premature — better to let Task 3 above (job durability) drive whether a queue abstraction is actually needed, rather than build one speculatively.

---

## STEP 5 — RESUME & INTERVIEW REVIEW

**Would this project stand out?** Yes, conditionally — the parts that stand out are the debugging narrative and the interface-driven architecture, not the feature list. A recruiter skimming a resume line would see "AI codebase assistant with RAG" and mentally file it as one of dozens of similar projects; a senior engineer actually reading the README and code would find something more specific.

**What's impressive:**
- Three verified, real, non-obvious bugs found and fixed with tests (the Mongoose index-timing race, the object-spread error-shape bug, the tree-sitter/web-tree-sitter version mismatch) — these are the kind of specific, technical stories that separate a real engineer from someone who followed a tutorial.
- The provider-swap history (Voyage → local embeddings; Claude → Groq), each one driven by a real external failure and executed cleanly because of the `IEmbeddingProvider`/`IChatCompletionProvider` interfaces — this is applied architecture, not textbook architecture.
- AST-based chunking with gap-filling, verified against real production code (not just synthetic test snippets) during development.
- Honest, specific documentation — the README explains *why*, including admitting what went wrong and why the trade-off was made.

**What still looks like a tutorial:** the core feature set itself — "import a repo, chat with it, get cited answers" — is the same shape as several existing open-source and commercial tools. The feature list alone doesn't differentiate; the engineering process behind it does, but only to someone who reads past the surface. This is exactly why §3's hardening tasks (measurable retrieval quality, job durability, rate limiting) matter more right now than any new feature in §2's gap table — they convert "looks like a RAG tutorial" into "looks like production engineering," which is the actual gap between this project and a portfolio piece that gets a callback.

**Which additions would create the biggest increase in interview value?**
1. The retrieval evaluation harness (Task 8) — turns an unfalsifiable claim ("the RAG works well") into a measured one.
2. Job durability (Task 3) — a concrete, specific production-reliability story.
3. The Architecture Visualizer, but *only* after the above — it's the most visually impressive feature to demo, and demoing it on top of a hardened core is a materially better story than demoing it on top of an unhardened one.

**Which additions are unnecessary complexity right now:** GitHub OAuth and private repos are legitimate roadmap items but add the least interview value per hour of work at this stage — they're "more of the same kind of thing already built" (auth, API integration) rather than new engineering territory. The various AI-action features (README generation, dead code detection, etc.) are each individually easy to describe but collectively risk turning this into "a project with twelve shallow features" instead of "a project with one deep, well-engineered feature" — the latter is a stronger story for a recruiter's first 30 seconds of attention.

**Scores (out of 10, current state):**

| Dimension | Score | Why |
|---|---|---|
| Architecture | 8 | Consistent layering, proven Strategy pattern, one honest DIP compromise at the route layer |
| Backend Engineering | 8 | Real bugs found and fixed with tests; error handling and config validation are genuinely strong |
| AI Engineering | 6 | Solid pipeline engineering (chunking, idempotency); weak on measurement — no retrieval evaluation exists yet |
| System Design | 6 | Good instincts (async job pattern, provider abstraction); the job-durability gap is a real system-design miss |
| Developer Experience | 8 | `.env.example` with rationale, clear README, fast local setup |
| Production Readiness | 5 | No rate limiting, no job recovery, log redaction gap — these are the audit's real findings, not nitpicks |
| Code Quality | 8 | Consistent, well-named, appropriately small units; minor DRY opportunity noted |
| Scalability | 4 | Honest single-process design; explicitly not yet built for horizontal scale, and says so |
| Resume Value | 7 | Strong if the reader goes past the feature list; average if they don't |
| Interview Value | 8 | The debugging stories and architecture decisions are genuinely strong material — contingent on Milestone 1.5 landing to back up the "production-minded" claim with evidence |

---

## STEP 6 — ROADMAP

The ordering below prioritizes converting *unfalsifiable claims into measured ones* and *closing real reliability gaps* before adding feature surface area — because that is what will actually move the scores in §5, more than any new feature would.

**Milestone 1.5 — Production Hardening (this document's §3, all 8 tasks).** Independently deployable after every single task. Estimated 4-6 days total. This is the highest-leverage work available right now.

**Milestone 1.6 — Retrieval quality iteration.** Once the evaluation harness (Task 8) exists, use it to actually try improvements (re-ranking, chunk-size tuning, a code-specific embedding model comparison) and measure whether they help. This turns Task 8 from "a harness that exists" into "a harness I used to make a real improvement, and here's the number."

**Milestone 2 — GitHub OAuth + private repos**, per the original design doc, now that the core is hardened. Deployable and demoable on its own.

**Milestone 3 — One AI action, chosen deliberately, built deep rather than several built shallow.** README generation or dead-code detection are the strongest single candidates — pick one, build it to the same standard as chat (tested, with a documented "why," not just "it works").

**Milestone 4 — Architecture Visualizer.** The most visually differentiating feature, deliberately sequenced last so it's demoed on top of a hardened, measured, already-impressive core rather than papering over gaps a technical interviewer would find in the first five minutes of looking past the demo.

Every milestone above is independently deployable and independently testable — stopping after any one of them leaves a coherent, demoable, honestly-described project.
