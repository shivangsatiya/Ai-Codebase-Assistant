# AI Codebase Assistant — Project Overview

A complete, honest explanation of what this project is, how it works, and what building it actually involved. Written to be read start to finish, or used as a reference for any specific part.

---

## What it is

A web application that lets you point it at any public (or, with a connected GitHub account, private) GitHub repository, and then either **chat with it** — ask questions in plain English and get answers grounded in the actual source code, with citations to specific files and line numbers — or **explore its architecture visually**, through a real, interactive dependency graph built from parsing the code itself, not guessed from an LLM.

Live, working, and deployed for free — no paid API keys, no paid database, no paid infrastructure anywhere in the stack.

---

## The problem it's solving

Understanding an unfamiliar codebase is slow. Reading through files one at a time doesn't tell you how things connect — which service calls which, what depends on what, where the actual entry points are. Most AI coding tools either don't have real knowledge of an entire repository's structure, or they hallucinate confidently about code they've never actually parsed.

This project takes a different, more disciplined approach: two clearly separated layers of information, never blended together without saying so.

- **Deterministic layer**: real, tree-sitter-based AST parsing of the actual source code. Every function, class, import, and dependency this layer reports is something that was verifiably found in the code — not inferred, not guessed.
- **Inferred layer**: an LLM's own read on higher-level architectural roles (this file looks like a route handler, this one looks like a database model) — clearly labeled as inferred, with its own confidence signal, never presented as equally certain as the deterministic layer.

This distinction — computed fact vs. AI-generated interpretation, always structurally separate, never silently merged — is a design principle that runs through the entire codebase, from the knowledge graph's own data model to the chat interface's citation system.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│   React Frontend │  HTTP   │   Express API Backend │         │   MongoDB Atlas  │
│  (Vite, TS, RF)  │◄───────►│  (Node.js, TypeScript) │◄───────►│ (chunks, graphs,  │
│  deployed: Render│         │   deployed: Render     │         │  users, jobs)     │
└─────────────────┘         └───────────┬───────────┘         └─────────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        ▼                 ▼                 ▼
                 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
                 │  GitHub API │   │  Groq (LLM) │   │ Local ONNX  │
                 │ (clone repo)│   │ Llama 3.3 70B│   │  Embeddings │
                 └─────────────┘   └─────────────┘   └─────────────┘
```

**Backend** (`apps/api`): Node.js + TypeScript + Express. MongoDB Atlas for both regular storage and vector search (`$vectorSearch`). Tree-sitter WASM for real AST parsing. A local ONNX embedding model (`all-MiniLM-L6-v2`) so there's no external embedding API dependency at all. Groq's free tier (Llama 3.3 70B) for chat completions and the LLM-inferred graph tier — chosen specifically because it requires no funded account (confirmed directly: Anthropic's API returns a `400` on a `$0` balance).

**Frontend** (`apps/web`): React 19 + TypeScript + Vite. React Flow for the interactive graph visualization, laid out automatically with ELK.js (a real constraint-based graph layout engine, not manual positioning). TanStack Query for all server state. Zustand for local UI state.

**Deployment**: two separate Render services — a Docker-based web service for the API, a static site for the frontend — defined together in a single `render.yaml` Blueprint. Both entirely on Render's free tier.

---

## What was actually built, by capability

### Repository import & parsing
Clone a real repository, walk its file tree, chunk every file (real AST-based chunking for JavaScript/TypeScript and Python — genuine function/class boundaries, not arbitrary line splits; a line-window fallback for every other language), generate real local embeddings for every chunk, and persist all of it — durably, with crash recovery (see below).

### The knowledge graph
A real, governed pipeline: extract candidate nodes and edges (both deterministic and inferred), deduplicate and canonicalize their identities, validate the resulting graph's structural invariants (no dangling edges, no orphaned nodes), and only then persist it — a rejected candidate graph is recorded as a real, visible failure with its specific reasons, never silently discarded or silently accepted anyway. Rendered as a real, interactive, auto-laid-out diagram in the frontend, not a static image.

### Chat, grounded in real retrieval
A question gets embedded, `$vectorSearch` retrieves the actual top-K most relevant chunks from that specific repository, a system prompt instructs the model to answer only from that retrieved context and cite `[filepath:startLine-endLine]` inline, and the response streams token-by-token over Server-Sent Events. Citations are parsed out and stored structurally alongside the message — never just trusted as free text.

### Production durability (the most architecturally significant single piece of work)
A crashed import job used to be stuck forever with no recovery path. Now: durable job state with bounded, classified retries; an atomic stale-job claim mechanism (a real, tested concurrent-double-claim regression exists for this) that safely resumes work after a crash; a durable chunk checkpoint so a resumed import can skip straight past the already-completed clone/chunk stages; full cleanup on repository deletion (chats, jobs, chunks, checkpoints, and the knowledge graph — verified against a real database, not just a fake); and a real, honest capacity benchmark that found and fixed two genuine, previously-undiscovered bugs (see below) rather than just measuring the happy path.

### Testing
Not an afterthought — 41 backend test suites (374 tests) and 18 frontend test suites (104 tests), all genuinely executed and passing on real runs, not just written and assumed correct. Includes dedicated crash-simulation tests for every real pipeline stage, a real database-backed test for cross-repository deletion isolation, and E2E browser automation (Playwright) for the graph UI.

---

## Notable engineering decisions and trade-offs (real ones, not idealized)

**Groq instead of Claude/OpenAI, local embeddings instead of an embedding API.** Both driven by the same constraint: this project had to remain genuinely free to run, with no funded account blocking the whole pipeline for anyone trying to use it. The trade-off is honestly documented too — an open model can be less reliable than Claude at strictly following a "cite in exactly this format" instruction.

**A durable job state machine reusing the existing stage enum, not a new one invented for the sake of durability.** A deliberate decision made during the design phase: new states only get added when they represent a genuine, durable boundary worth surviving a crash — not simply for the sake of having more granular status reporting.

**No database transactions for the multi-step delete cascade.** A real, considered trade-off: deleting dependent data first and the parent record last bounds the worst-case failure mode (an orphaned child record, cleanable later) without taking on the real complexity of this project's first database transaction, appropriately scoped for the project's actual size.

**A Staff Engineer Review, not just a feature checklist, before declaring a milestone complete.** A genuine, critical self-audit against concurrency, reliability, security, and complexity — one that found and honestly documented a real limitation (a stale-job threshold race condition) rather than declaring victory prematurely.

---

## Real bugs found and fixed — with root cause, not just a patch

**An empty file could fail an entire large import outright.** Traced to a genuine JavaScript quirk: `"".split('\n')` returns `['']` (length 1), not `[]` — so a completely empty file's own chunking guard clause never actually triggered, producing one chunk with empty content. Because the chunk-persistence layer re-throws any error that isn't a duplicate-key conflict, that one empty chunk (something as ordinary as a blank `__init__.py`) would fail the *entire* import at the very last step — discarding all the expensive prior work. Found only by running a real, large, 2,649-file open-source repository (`pandas`) through the system as part of a genuine capacity benchmark. Fixed at the actual root cause, with 7 new regression tests, including a direct reproduction of the original failure.

**A theoretical concurrency risk, confirmed live.** A prior internal review had flagged, as a theoretical possibility, that the stale-job recovery sweep could incorrectly claim a job that was still genuinely, correctly running, if a single stage legitimately took longer than its threshold. The same large-repository benchmark run confirmed this directly and reproducibly: a 45,161-chunk embedding stage ran past the threshold, the sweep claimed the still-live job twice, and each phantom resume attempt burned real retry budget without ever having a fair chance to succeed — while the actual work kept running, undetected, in the background. Documented as a real, accepted limitation with a clear explanation of what a proper fix would require, rather than a rushed, risky patch.

---

## Known limitations (stated honestly, not hidden)

- The single most significant one: local embedding inference runs synchronously inside Node's single-threaded event loop, so a large import can make the *entire application* — including completely unrelated things like logging in — unresponsive for its duration. Measured directly: real response times of 60–78 seconds during a large import, and one real, cascading session-revocation triggered by the resulting delay.
- Only JavaScript/TypeScript and Python get real AST-based parsing; other languages fall back to a lower-fidelity line-window chunker.
- The free-tier LLM quota caps how much of a very large repository's graph can get the inferred (LLM-enhanced) tier — the deterministic tier is unaffected and always completes.
- The production deployment's `MAX_REPO_FILES` is set far lower (15) than local development's default (3000), a real, previously-confirmed constraint of Render's free 512MB memory tier.

---

## What this project demonstrates

Real, end-to-end system design across a genuinely full stack — not a tutorial clone. A durable, crash-recoverable background job system built and verified with the same rigor a production incident review would demand. A benchmark effort that found and fixed real bugs rather than just producing numbers. Honest, written self-review at every major milestone, including documenting what *didn't* get finished and why. A live, working, fully free deployment — the actual, hard part of "just run it," not just a `README` claiming it works.
