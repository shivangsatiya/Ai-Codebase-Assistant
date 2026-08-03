# AI Codebase Assistant

Chat with a real GitHub repository and get answers grounded in the actual source code, with citations to specific files and line numbers.

## Status: Milestone 1, Day 5 — Chat / Retrieval (complete)

### What's implemented

- **Auth, repo import, parsing, chunking, embeddings** — Days 1-4.
- **Chat, end to end:** start a chat scoped to a `ready` repository → ask a question → the question is embedded → `$vectorSearch` retrieves the top-K most relevant chunks, filtered to that repository → a system prompt is built instructing the model to answer only from that context and cite `[filepath:startLine-endLine]` inline → **Groq (Llama 3.3 70B)** streams the answer token-by-token over Server-Sent Events → citations are parsed out of the completed response and stored alongside the message.

### LLM provider: why Groq, not Claude

The Anthropic API requires a funded account - a `$0` credit balance returns a `400` on every request (confirmed live during development). Groq's free tier needs no payment method at all, which is the same reasoning that led to running embeddings locally on Day 3-4: an external account that can block the whole pipeline isn't acceptable for a project meant to just work. `IChatCompletionProvider` was built specifically to make this swap cheap - one new client file (`clients/groq-chat.client.ts`), one line changed in the composition root, nothing else touched.

Worth being upfront about the trade-off: Llama 3.3 70B (an open model) can be less reliable at strictly following the "always cite in this exact format" system prompt instruction than Claude would be. If citation quality looks inconsistent in testing, that's this trade-off surfacing, not a bug in the prompt or the citation-extraction regex.

### One manual setup step this milestone genuinely requires: the Atlas Vector Search index

`$vectorSearch` cannot be created through Mongoose or any code in this repo — it's configured directly in the Atlas UI (or via the Atlas Admin API), separate from normal MongoDB indexes. **Chat will not work until you create this.**

1. In MongoDB Atlas, go to your cluster → **Search & Vector Search** tab → **Create Search Index**.
2. Choose **JSON Editor**, select the `chunks` collection in your database.
3. Name the index exactly `chunk_vector_index` (must match `VECTOR_INDEX_NAME` in `src/repositories/chunk.repository.ts`).
4. Paste this index definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 384,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "repositoryId"
    }
  ]
}
```

`numDimensions: 384` matches `all-MiniLM-L6-v2`'s output size exactly - if you ever change `LOCAL_EMBEDDING_MODEL` to a model with a different embedding dimension, this index has to be rebuilt to match. The `filter` field on `repositoryId` is what makes `$vectorSearch` correctly scope results to one repository instead of searching across everyone's imported repos.

5. Wait for the index status to show **Active** (usually under a minute) before testing chat.

### Architecture (additions since Day 3-4)

```
models/chat.model.ts, message.model.ts   chat + message schemas, with citation storage
repositories/chat.repository.ts           chat/message data access
services/retrieval.service.ts             embeds the query, runs vector search scoped to the repo
services/chat-prompt.ts                   pure functions: system prompt construction + citation extraction
services/chat-orchestration.service.ts    ties retrieval + prompt + streaming + storage together
clients/chat-completion-provider.ts       shared streaming LLM interface
clients/groq-chat.client.ts               Groq API streaming implementation (Llama 3.3 70B, free tier)
routes/chat.routes.ts                     POST /api/chats/:id/messages (SSE)
config/composition-root.ts                single source of truth for shared singletons (see below)
```

**Why a composition root now, when earlier days didn't need one:** `LocalEmbeddingClient` lazily loads a ~90MB model into memory on first use. Both indexing (`RepositoryImportService`) and chat (`RetrievalService`) need an embedding provider - if each route file built its own instance (as `repository.routes.ts` originally did), the model would load twice, doubling memory and load time for no reason. `config/composition-root.ts` builds every shared dependency exactly once; every route file imports from there instead of constructing its own copies.

**A testing limitation worth being upfront about:** `$vectorSearch` only works on real Atlas - `mongodb-memory-server` (what the test suite uses) doesn't support it at all. `RetrievalService` and `ChatOrchestrationService` are fully unit-tested against fake repositories/providers (verifying retrieval scoping, prompt construction, citation extraction, streaming order, and message persistence), but the actual `$vectorSearch` query can only be verified live, against real Atlas, with the index above in place.

## Running locally

```bash
cp apps/api/.env.example apps/api/.env
# fill in MONGODB_URI, JWT_SECRET, and GROQ_API_KEY (free, no payment method - get one at console.groq.com)

npm install
npm run dev:api
```

Then create the Atlas Vector Search index described above before testing chat.

## Testing

```bash
npm run test:api
```

## Milestone 1.5 — Production Hardening (complete)

A full production-readiness audit was performed after Milestone 1 (`docs/production-readiness-audit.md`) — it's worth reading in full, since it's an honest account of real gaps found by checking the code, not a generic checklist. Hardening work proceeds one task at a time, each with its own rationale, self-review, and tests, tracked below:

- [x] **Task 1 — Secure logging.** The audit found `Authorization` headers were logged in plaintext on every authenticated request (verified directly in this project's own dev logs). Fixed via `pino`'s `redact` option (`src/utils/logger.ts`), covering the specific leak (`req.headers.authorization`, `req.headers.cookie`) plus defense-in-depth wildcard coverage for any field named `password`, `passwordHash`, `accessToken`, `refreshToken`, or `token` appearing anywhere in a logged object — not just the one path that happened to be noticed. Verified both manually (a standalone script proving redaction actually fires) and with an automated test suite (`tests/logger-redaction.test.ts`) that imports the exact same redaction list the real logger uses, so the test can't silently drift from what's actually configured.
- [x] **Task 2 — Rate limiting.** The audit found zero rate limiting anywhere. Fixed with `express-rate-limit`, applied two ways: **IP-based** on `/api/auth/register` and `/api/auth/login`, sharing one combined budget of 5 total attempts/15 min per IP (a deliberate choice — a separate budget per endpoint would let an attacker interleave register and login attempts to double their effective rate) and **user-based** (keyed by `req.userId`, applied *after* `requireAuth`) on `POST /api/repositories` (10/hour — the most expensive operation this API performs: a real clone plus CPU-bound local embedding) and `POST /api/chats/:id/messages` (30/hour — real but cheaper than a full import). All three report through the app's standard `{ error: { code, message } }` shape via the existing `RateLimitedError` class, which the earlier audit had flagged as unused dead code — it's live now. A genuine additional finding surfaced while implementing this: `app.set('trust proxy', ...)` was never configured, which would have made IP-based limiting silently useless the moment this deploys behind Render's reverse proxy (every request would appear to share the proxy's IP) — fixed alongside this task. Verified with real runtime tests (not just type-checking) proving the Nth request actually gets blocked, that per-key counters are genuinely independent, and that a second bug — the default in-memory store's low test-appropriate limits would have broken the existing `auth.routes.test.ts` suite, which legitimately registers several users in sequence — was caught and fixed before it could ship broken. Also verified live: manual testing initially looked confusing (the limiter triggered on the 4th wrong-password attempt, not the 6th) until realizing the earlier account-setup calls (a login, then a register) had already consumed 2 of the 5 shared slots — confirmed as correct behavior for the shared-budget design, not a bug, and the code comment was tightened to make this explicit for the next reader. A third bug surfaced only once the server was actually started locally (not caught by automated tests, since it fires at module-load time rather than per-request): `express-rate-limit`'s startup validation rejected the user-scoped limiters' `keyGenerator` (`ERR_ERL_KEY_GEN_IPV6`) because their defensive fallback to `req.ip` — for a case that should never actually happen, since these limiters only run after `requireAuth` — used the raw IP directly instead of the library's own `ipKeyGenerator()` helper, which normalizes IPv6 addresses to a subnet prefix so a client can't bypass the limit by rotating through addresses in the same subnet. Fixed by wrapping the fallback in `ipKeyGenerator()`; verified by directly constructing the Express app in isolation to prove the validation error was actually gone, not just assumed fixed, then confirming the full test suite still passed.
- [x] **Task 3 — Refresh token flow.** The audit found `register`/`login` issued a refresh token that no endpoint could ever redeem. Recommendation (implement, not remove): a genuinely unusable 15-minute session was the actual alternative, and every other "found but unused" gap in this audit got fixed rather than deleted. Implemented as **rotation with reuse detection** — each refresh token carries a unique `jti` tracked in a new `refresh_tokens` collection (a plain JWT alone can't be individually revoked or single-use; the `jti` is what adds that). Every successful `POST /api/auth/refresh` burns the presented token and issues a brand new pair; presenting an already-rotated-out token a second time is treated as the specific signal of theft and revokes *every* refresh token for that user, not just the reused one — the attacker may already hold a more recent one from the same family. `POST /api/auth/logout` (revoking the presented token) came essentially free once this infrastructure existed and closes another gap the audit named separately, rather than building the same collection twice later. `RefreshTokenModel` uses a MongoDB TTL index so expired records clean themselves up automatically, no cron job required. Two real things self-review caught before shipping: (1) a wrong test assertion — expecting two access tokens minted within the same wall-clock second to always differ, which isn't a real guarantee this system makes (JWT's `iat` only has second-level granularity; the refresh token's `jti`-driven uniqueness is what rotation actually depends on, and that *is* tested and enforced); (2) `ChatModel` and `MessageModel` had been missing from the startup index-readiness wait since Day 5 — the exact class of bug that caused the Day 3-4 chunk-idempotency race — caught and fixed for all three new/existing models while implementing this task, not just the new one.
- [x] **Task 4 — Restrict CORS.** The audit found `cors()` called with no options, defaulting to `Access-Control-Allow-Origin: *` — any website could make cross-origin requests to this API from a browser. Fixed with an `ALLOWED_ORIGINS` env var (comma-separated, defaulting to common local dev frontend ports so local development doesn't regress), passed directly as `cors()`'s `origin` array. Worth being precise about a real limitation of this task: CORS is enforced by the *browser* reading the `Access-Control-Allow-Origin` response header, not by the server refusing to respond — none of this project's usual PowerShell/`Invoke-RestMethod` verification steps can test it, since those tools ignore CORS entirely. Verified instead with a dedicated test suite asserting the actual response headers our configuration produces: an allowed origin gets echoed back in `Access-Control-Allow-Origin`, a disallowed one gets no such header at all (confirmed directly in the `cors` package's real behavior, not assumed from its documentation), and a request with no `Origin` header (a server-to-server call) is unaffected either way.
- [x] **Task 5 — Health/readiness endpoint.** The audit found `/health` returned `{status: "ok"}` unconditionally, never checking whether MongoDB was actually connected — a liveness-only check with no way to detect "the process is up but useless right now." Split into `/health/live` (always 200 if the process can respond at all — deliberately checks nothing else, since restarting a healthy process over a momentary DB blip just adds churn without fixing anything) and `/health/ready` (checks `mongoose.connection.readyState`, returns 503 if not fully connected) — the standard liveness/readiness split every real orchestrator (Kubernetes, Render) expects as two separate probes, not one combined endpoint. Deliberately scoped to MongoDB only, not Groq or the embedding model — Mongo is touched by every request (even a JWT-only auth check hits the DB), while Groq only matters for chat requests and the embedding model has no ongoing "connection" to check the way a database does; checking only what can meaningfully fail is more honest than adding checks that would always just return "ok." Verified with a dedicated test suite that includes deliberately disconnecting the real test database mid-run and confirming `/health/ready` correctly reports `503`, then reconnecting so the rest of the suite isn't affected — not just testing the easy "already connected" path. Self-review caught a real break before it shipped: `cors.test.ts` (from Task 4) still referenced the old `/health` path, which no longer existed after this change — caught by grepping for the old path across the whole repo before considering the task done, not left for the next `npm test` to discover.

**Milestone 1.5 is now complete — all 5 tasks closed, each implemented, self-reviewed, tested, and documented.** 102 tests passing at last full count on the real development machine (including every real-MongoDB suite this sandbox couldn't run). Several real bugs were found and fixed along the way that no amount of planning would have caught up front — a Mongoose index-timing race from Day 3-4 recurring in a new model, a startup-time-only validation error invisible to any HTTP-level test, a wrong test assumption about JWT timestamp granularity, and two documentation-drift breaks caught by grepping the repo rather than assuming a change was isolated. That's the actual production-hardening story: not that the code was written correctly the first time, but that a consistent process (explain, implement, self-review, test, document) kept catching what the first pass missed.

## Deployment

### Docker

The original Day 1 `Dockerfile` was written before this project had any native-compiled dependencies and needed real rework once it had three (`bcrypt`, and `sharp`/`onnxruntime-node` via `@huggingface/transformers`):

- **Base image switched from `node:20-alpine` to `node:20-bookworm-slim`.** Alpine uses musl libc; the prebuilt binaries these native packages ship target glibc. Alpine + native npm dependencies is one of the most common, well-documented sources of "works locally, breaks in Docker" failures in the Node ecosystem — a real risk with three native dependencies now, worth the ~130MB larger image size to avoid.
- **Fixed the install step.** It ran `npm ci --workspace=apps/api`, which scopes which workspace's *scripts* run — correct for the later `npm run build --workspace=apps/api`, but not the right way to install a monorepo's full dependency tree. Now runs unscoped (`npm ci`) at the workspace root.
- **Added a `.dockerignore`** (didn't exist before) — host `node_modules`, `.git`, `.env`, and `dist` were never explicitly excluded from the build context.
- **`libgomp1` added defensively** to the runtime image — `onnxruntime-node` commonly links against GNU's OpenMP runtime for parallelized CPU inference. This couldn't be confirmed as strictly necessary without an actual build test, but the failure mode if it's needed and missing is bad (a clean startup, then a crash the first time someone actually imports a repository) — cheap to include either way.
- **A `HEALTHCHECK` directive**, checking `/health/live` (not `/health/ready`) — deliberately the liveness endpoint here specifically, so a transient MongoDB blip doesn't make Docker's own tooling (`docker ps`, compose's `depends_on: condition: service_healthy`) consider the container unhealthy. This is a genuinely different answer from Render's own `healthCheckPath` in `render.yaml`, which *does* check `/health/ready` — two different tools asking two different questions, not an inconsistency. Uses `node` itself to make the HTTP request, since neither `curl` nor `wget` is installed in this minimal image.

**Honest limit on what's verified here:** Docker itself isn't available in the development sandbox this project was built in, so the actual multi-stage `docker build` has never been run end-to-end. What *was* verified: the exact `npm ci` → `npm run build` sequence the Dockerfile runs, executed for real in a clean environment, produces the expected `dist/server.js`; and the two modules requiring native bindings (`bcrypt`; `onnxruntime-node`/`sharp` via the embedding client) load without a binding error on real glibc Linux — the same compatibility axis Debian bookworm-slim shares, though not the identical distribution. **Running `docker build` (or `docker compose up --build`) yourself is the real verification step for this part** — treat it the same way live testing has caught real bugs automated tests couldn't, throughout this whole project.

### Local Docker testing

```bash
cp apps/api/.env.example apps/api/.env
# fill in your real values
docker compose up --build
```

If the build succeeds and the container starts cleanly (same `MongoDB connected` / `API server started` log lines as running it directly with `npm run dev:api`), the Docker rework is confirmed working.

### Render

`render.yaml` at the repo root is a [Render Blueprint](https://render.com/docs/blueprint-spec) — connect this repo in the Render Dashboard and choose "Deploy Blueprint," and Render detects and applies it automatically.

A few decisions worth understanding, not just copying:

- **`dockerfilePath: apps/api/Dockerfile` with `dockerContext: .`** (the repo root, not `apps/api/`) — the Dockerfile's own `COPY package.json package-lock.json* ./` step expects the full monorepo root as build context to resolve the npm workspaces dependency tree correctly.
- **`healthCheckPath: /health/ready`, not `/health/live`.** This is the opposite choice from the Docker `HEALTHCHECK` directive above, and deliberately so: Render's own health-check documentation explicitly recommends checking operation-critical dependencies (their own example is "executing a simple database query to confirm connectivity"), and — unlike a bare Kubernetes liveness probe — Render's `healthCheckPath` already has built-in grace periods (15s before pausing traffic to a failing instance, 60s before restarting it) that absorb a momentary Mongo blip on their own. Using `/health/ready` here follows Render's own stated platform design rather than mechanically porting a Kubernetes liveness-only convention onto a platform that isn't Kubernetes.
- **`JWT_SECRET` uses `generateValue: true`** — Render generates a cryptographically random value itself; there's no need to run `openssl rand -base64 32` and paste it in by hand for this one specifically.
- **Every other secret (`MONGODB_URI`, `GROQ_API_KEY`, `ALLOWED_ORIGINS`, `GITHUB_TOKEN`) is marked `sync: false`** — Render creates the environment variable but leaves it empty, prompting you to fill in the real value in the Dashboard after the Blueprint runs. None of these are ever committed to source control, even as placeholders.

After the Blueprint creates the service, go to its Environment tab and fill in the four `sync: false` values before the first deploy will actually work end-to-end.

### Smoke testing a deployment

`scripts/smoke-test.ps1` exercises the exact same flow verified manually throughout local development — health checks, register, import a real repo, poll until ready, start a chat, ask a real question — against a live deployed URL, so deployment verification is a repeatable script rather than a one-time manual check nobody runs again after the first deploy:

```powershell
.\scripts\smoke-test.ps1 -BaseUrl "https://your-service.onrender.com"
```

**Honest limit on what's verified here:** this script was written and self-reviewed against exactly the request/response shapes this project has empirically confirmed, repeatedly, throughout local development (including the specific, previously-surprising observation that `Invoke-RestMethod` returns an SSE chat response as raw text containing literal `"token"` and `event: done`/`event: error` substrings) — but it has never been executed against a real deployment, since that requires an actual Render account and deployed service neither exists in the development sandbox this project was built in. **Running it yourself against your real deployed URL is the genuine verification step.**

## API Reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/register` | POST | none | Create an account |
| `/api/auth/login` | POST | none | Get a JWT |
| `/api/repositories` | POST | JWT | Import a public repo (returns 202 + job id); runs the full parse/chunk/embed pipeline |
| `/api/repositories/:id` | GET | JWT | Poll import status |
| `/api/repositories/:id/chats` | POST | JWT | Start a chat scoped to a `ready` repository (409 if not ready) |
| `/api/chats/:id/messages` | POST | JWT | Ask a question; streams the answer via Server-Sent Events, cited inline |
