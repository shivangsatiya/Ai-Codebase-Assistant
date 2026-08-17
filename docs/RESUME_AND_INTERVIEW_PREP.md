# AI Codebase Assistant — Quick Reference (Resume & Interview Prep)

## One-liner

A full-stack AI application that lets you chat with any GitHub repository (with real, cited answers grounded in the actual code) and explore its architecture through a real, parsed dependency graph — deployed live and running entirely on free infrastructure.

## 30-second spoken pitch

"I built a full-stack app that ingests a GitHub repo, actually parses it with tree-sitter to build a real dependency graph, and lets you chat with the codebase using retrieval-augmented generation — every answer is grounded in real chunks of code with file and line citations, not hallucinated. The interesting engineering problem was making the whole import pipeline durable — if it crashes halfway through a large repo, it recovers and resumes instead of losing all the work. I found and fixed two real bugs doing a proper performance benchmark against a 2,600-file open-source repo, and it's deployed live, completely free — no paid API keys or infrastructure anywhere."

---

## Resume bullet points (pick 3–4 depending on space)

- Designed and built a full-stack RAG (retrieval-augmented generation) application in TypeScript/React/Node.js that ingests GitHub repositories, performs real AST-based parsing (tree-sitter) to build a governed knowledge graph, and answers user questions with citation-grounded LLM responses over Server-Sent Events
- Architected a durable, crash-recoverable background job pipeline (atomic stale-job claiming, bounded classified retries, checkpoint-based resume) for long-running repository imports, verified with dedicated crash-simulation and concurrency regression tests
- Ran a real capacity benchmark against a 2,600+ file production open-source repository, discovering and fixing two previously-undetected bugs (including a root-cause JavaScript string-parsing edge case that could silently fail an entire large import) with full regression test coverage
- Deployed a production application entirely on free-tier infrastructure (Render, MongoDB Atlas, Groq, local ONNX inference) — zero paid API keys or services — including a Docker-based backend and a static frontend wired together via Infrastructure-as-Code (Render Blueprint)
- Maintained 40+ backend and 18+ frontend test suites (480+ tests total) with genuine, repeatedly-verified execution across every major change, plus written self-review documents auditing correctness, concurrency, and production-readiness at each milestone

---

## If they ask, here's a real, specific answer ready to go

**"Tell me about a bug you found and fixed."**
→ The empty-file chunking bug. `"".split('\n')` in JavaScript returns `['']`, not `[]` — a one-element array, not zero. So a completely empty file's own "skip if there's nothing here" check never actually triggered. That produced one chunk with empty content, and because the database schema requires non-empty content, that single chunk failed validation — and because the persistence code only tolerates duplicate-key errors (by design, for idempotency), it re-threw everything else, failing the *entire* import at the very last step. An empty `__init__.py` — something totally ordinary in a real Python repo — could nuke an hours-long import. Found it by actually running a real, large open-source repo through the system as a benchmark, not by guessing. Fixed at the root cause, plus a defensive filter as a second layer of protection, with real regression tests reproducing the original failure.

**"Tell me about a hard technical decision."**
→ Whether to add complexity (a heartbeat mechanism, database transactions) to close every theoretical edge case, or scope it deliberately and document the trade-off. I found a real, confirmed race condition where a stale-job recovery sweep could incorrectly reclaim a job that was still genuinely running, if one stage took longer than its timeout. The "complete" fix needs a real heartbeat system — meaningful added complexity for a portfolio-scale project. I documented it explicitly as a known, accepted limitation instead of either ignoring it or over-engineering a fix nobody would actually need yet.

**"How do you approach testing?"**
→ Every significant change was actually run and re-verified — not "the AI/I wrote tests" as a checkbox, but real, repeated confirmation on real infrastructure, including catching genuine flaky-test race conditions and dependency-version-sensitive TypeScript issues along the way. I also wrote dedicated crash-simulation tests for every real pipeline stage (what happens if cloning fails, chunking fails, embedding fails, persistence fails) — not just the happy path.

**"Why Groq / local embeddings instead of OpenAI or Claude?"**
→ Cost and access, honestly. The whole project had to run on genuinely free infrastructure — an API that requires a funded account (confirmed Anthropic's does, even at $0 balance) would block anyone trying to actually use it. I built the LLM provider behind a small interface specifically so that swap was a one-file change, not an architecture rewrite.

**"What would you do differently / what's not finished?"**
→ I'd be honest about it: the local embedding model runs on the same single thread that serves every other request, so a large import can make the whole app briefly unresponsive — including logging in. I found this directly, with real measured numbers, during benchmark testing. The proper fix is moving that work off the main thread (a worker thread or separate process) — a real architectural change I scoped out of a measurement-focused benchmark task, documented clearly rather than either hiding it or rushing an untested fix.

---

## The live project

- Live app: your Render frontend URL
- Repo: your GitHub repo URL
- Full technical write-up: `docs/PROJECT_OVERVIEW.md` in the repo
