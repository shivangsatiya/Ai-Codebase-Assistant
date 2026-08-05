# Milestone 2 Design — GitHub OAuth, Private Repositories, Repository Management

Written before any code, per the roadmap. Every GitHub-specific detail below (endpoint shapes, scope names, token behavior) was checked against GitHub's current documentation, not assumed from training data — this project has been burned before by assuming platform behavior instead of verifying it.

---

## 1. Feature Specification

**In scope:**
- Connect a GitHub account via OAuth (the standard "Authorize application" web flow)
- Import **private** repositories the connected account has access to
- List all repositories a user has imported (`GET /api/repositories` — genuinely doesn't exist yet, a real gap)
- Delete an imported repository (`DELETE /api/repositories/:id`)
- Disconnect a GitHub account (`DELETE /api/auth/github`)
- Secure, encrypted-at-rest storage of the GitHub access token

**Deliberately out of scope, with reasons:**
- **GitHub Apps** (the more modern alternative to OAuth Apps) — see §5, Trade-off 1.
- **Organization-level installations / SSO enforcement** — adds real complexity (SAML authorization flows) with no portfolio-project payoff; a single user connecting their own personal GitHub account covers the interesting engineering ground.
- **Token refresh** — classic GitHub OAuth App tokens don't expire by default (unless the user or an org enables expiring tokens, which we can't control), so there's no refresh flow to build. Worth stating explicitly rather than silently omitting it.
- **Re-syncing a repository's list of files after the original commit** (i.e., "does this private repo need periodic re-import if it changes") — the existing `commitSha`-based idempotency already handles re-import correctly; a scheduled re-sync is a real feature but a separate one, not implied by "add OAuth."

---

## 2. Architecture

*Revised after a Principal Engineer design review (see `milestone-2-design-review.md`) — every change below is a direct fix from that review, not a stylistic pass.*

### 2.1 New data models

**`GitHubConnection`** (one per user, at most — connection is an **upsert**, not an insert, so reconnecting after revoking access or re-granting scope doesn't hit a duplicate-key error):
```
userId          ObjectId, unique index
githubUserId    number          — GitHub's numeric user id, not username (usernames can change); indexed
                                   (not uniquely constrained — see §4, Trade-off 4: allowing the same
                                   GitHub identity to connect to multiple app accounts is a deliberate
                                   non-decision, not an oversight)
githubUsername  string          — display only, refreshed on each connect
encryptedToken  string          — ciphertext only, see §2.5 for the full encrypted-value shape
iv              string          — base64, unique per encryption (see §2.5)
authTag         string          — base64, GCM's authentication tag (see §2.5)
keyVersion      number          — which TOKEN_ENCRYPTION_KEY encrypted this value (see §2.5); always
                                   1 today, but present from day one so a future key rotation is an
                                   additive change, not a breaking migration
scopes          string[]        — what was actually granted (GitHub can grant less than requested)
connectedAt     Date
```

**`GitHubOAuthState`** (short-lived, TTL-indexed — same pattern as `RefreshToken`'s TTL index from Milestone 1.5):
```
state       string, unique      — random, unguessable value
userId      ObjectId            — WHO initiated this flow (see §2.3 for why this is necessary)
expiresAt   Date                — 10 minutes, matching GitHub's own code expiry window
```

**A real concurrency bug the original design missed, and its fix:** consuming a `GitHubOAuthState` record must be a single atomic `findOneAndDelete({ state })`, never a separate find-then-delete. Written as two steps, two concurrent requests carrying the same `state` (a replayed or duplicated callback) could both pass the lookup before either completes the delete — both would proceed to complete the OAuth flow. This is structurally the same class of bug as the Day 3-4 Mongoose index-timing race: a check and an action separated in time, racing against a concurrent duplicate of itself.

### 2.2 New/changed endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/github` | GET | JWT required | Generates `state`, stores it tied to the caller's `userId`, redirects the browser to GitHub's authorize URL |
| `/api/auth/github/callback` | GET | **None** — see §2.3 | GitHub redirects here with `code` + `state`; exchanges code for a token, stores the connection |
| `/api/auth/github` | DELETE | JWT required | Revokes the token via GitHub's API, deletes the local `GitHubConnection` |
| `/api/repositories` | GET | JWT required | **New.** Lists the authenticated user's imported repositories — doesn't exist today despite being basic CRUD, a real gap this milestone closes |
| `/api/repositories/:id` | DELETE | JWT required | Deletes a repository and its chunks |

### 2.3 The OAuth flow, and the one genuinely tricky part

```
User (browser, already logged in)
  │
  ├─ GET /api/auth/github  (real JWT Bearer header present)
  │     server: generate state, store {state, userId}, 302 → github.com/login/oauth/authorize
  │
  ├─ [User approves on GitHub's own page]
  │
  ├─ GitHub 302s the BROWSER → /api/auth/github/callback?code=...&state=...
  │     ⚠ This request carries NO Authorization header — it's the browser
  │       following a redirect GitHub issued, not an API call our own
  │       client made. There is no JWT to check here.
  │
  server: look up `state` → recover the userId who started this
          exchange `code` for an access_token (server-to-server, POST
          github.com/login/oauth/access_token, client_secret never
          leaves the server)
          store the GitHubConnection for that userId
          delete the consumed GitHubOAuthState record (single-use)
```

**Why this matters and isn't a minor detail:** this project's entire auth model is stateless JWT Bearer tokens — there is no session cookie GitHub's redirect could carry back to us. The `GitHubOAuthState` record is what bridges "an anonymous-looking browser redirect" back to "a specific logged-in user," and its `state` value is simultaneously doing CSRF protection (GitHub's own documented purpose for the parameter) and identity resolution (this project's specific need, since it has no cookie-based session to fall back on). Both jobs, one value, one lookup.

**Reliability of the token exchange call.** Unlike the import pipeline's background retries, the token exchange (`POST github.com/login/oauth/access_token`) is a single-shot, synchronous call with a human waiting in a browser tab — if it fails outright with no retry, the user has to redo GitHub's own authorize page from scratch. A short retry (2 attempts, brief backoff) applies specifically to this one call, with a clear, actionable error if both attempts fail rather than a generic 500.

**Token invalidity discovered later, not at connection time.** A token can become invalid between when it was granted and when it's actually used for an import (the user revokes access on GitHub's side, an org enforces token expiration). A `401` from GitHub during a later import must translate into a specific, actionable error ("Your GitHub connection is no longer valid — please reconnect") rather than surfacing as an indistinct import failure.

**The identity-resolution rule, stated as an explicit constraint, not left implicit:** which user's token gets used for an import is resolved from the authenticated caller's own verified JWT (`req.userId`) exclusively — never from a repository ID, a request body field, or any other client-influenced value. This is the specific rule that prevents one user's private-repo access from ever becoming reachable through another user's request.

### 2.4 Enabling private repos in the existing pipeline

Two existing classes need to accept an optional per-user token, threaded through from wherever the import is triggered:

- **`GitHubClient.fetchRepoInfo()`** — currently unconditionally throws `ForbiddenError` if `data.private === true`. Changes to: accept an optional user token; if provided, use it for the API call and *allow* private repos through. If the token doesn't actually grant access to that specific repo, GitHub's API itself returns 404 — the existing `NotFoundError` handling already covers this correctly, no new error-handling code needed. GitHub does our access control for us for free here.
- **`GitClonerClient.clone()`** — a private repo's `git clone` needs the token embedded in the clone URL (`https://x-access-token:TOKEN@github.com/owner/repo.git`) or passed via a credential helper. **A real, existing bug this surfaces**: `git-cloner.client.ts` currently logs `logger.error({ err, cloneUrl }, 'Git clone failed')` on failure — the moment `cloneUrl` can contain an embedded token, this becomes a credential leak into logs, the same class of issue Milestone 1.5's Task 1 fixed for `Authorization` headers. This has to be fixed as part of this milestone, not after.

**SSRF, checked explicitly rather than left implicit.** Once a real user credential is embedded in a clone URL, any gap in validating the URL's target domain becomes higher-stakes than before. Checked against the actual code: `GitHubClient`'s existing `GITHUB_URL_PATTERN` regex (`^https:\/\/github\.com\/...`) already strictly constrains this — the constraint that matters is that the authenticated clone URL must always be constructed from the **validated, parsed** `owner`/`repo` values, never by re-interpolating raw user input directly. This holds in the current design; stated explicitly here so it stays a checked invariant, not an assumption that erodes silently as the code evolves.

**Shell injection, verified against `simple-git`'s actual implementation, not assumed from its documentation.** `simple-git` calls Node's `child_process.spawn(command, args, options)` — a separate command and an **argv array**, not a single shell string (confirmed by reading `simple-git`'s own compiled source). Arguments, including a clone URL with an embedded token, are passed directly to the `git` binary; no shell ever interprets them, so shell metacharacters in a token (however unlikely in practice) aren't an injection vector.

---

## 3. Security Design

### 3.1 Token encryption at rest — full design

A GitHub OAuth token isn't a password — it can't be hashed one-way, because the app needs the actual plaintext value back to make API calls on the user's behalf. It needs **reversible** encryption instead: AES-256-GCM (authenticated encryption — detects tampering, not just confidentiality).

**The original version of this section was incomplete** — it named the algorithm but left IV handling, auth tag storage, and key format unspecified, each a real gap:

- **IV (nonce):** AES-GCM requires a **unique** IV per encryption under a given key — reusing one doesn't just weaken security, it can leak the authentication key entirely. A fresh random 12-byte IV (`crypto.randomBytes(12)`) is generated on every single encryption call and stored alongside the ciphertext (the `iv` field in `GitHubConnection`, §2.1) — it isn't secret, it just has to be unique and available at decryption time.
- **Auth tag:** GCM produces a 16-byte authentication tag that must be stored and verified on decrypt, or the "authenticated" half of "authenticated encryption" provides no actual guarantee — it degrades to plain confidentiality with no tamper detection. Stored as its own field (`authTag`), not folded silently into the ciphertext.
- **Key format:** `TOKEN_ENCRYPTION_KEY` is a base64-encoded 32-byte value (`openssl rand -base64 32` — the exact same generation pattern already used for `JWT_SECRET`), validated at startup by the existing Zod env schema so a malformed key fails loudly at boot, not on the first encryption attempt in production.
- **Key versioning:** every encrypted value stores a `keyVersion` (§2.1), even though only one key exists today. This costs nothing now and avoids a forced flag-day cutover — or a painful schema migration under time pressure — the day key rotation actually becomes necessary.

**Abstracted behind an interface, consistent with the rest of the codebase.** `IEmbeddingProvider`, `IChatCompletionProvider`, and `IGitHubClient`/`IGitClonerClient`/`IChunkingService` (introduced in Milestone 1.75 specifically to fix a testability gap) all exist for the same reason this needs to: a `TokenEncryptor` class implementing `ITokenEncryptor` (`encrypt(plaintext): EncryptedValue`, `decrypt(value: EncryptedValue): string`), built once in the composition root. This isn't ceremony for its own sake — it's what lets the OAuth callback handler and the import pipeline be tested against a fake encryptor instead of exercising real Node `crypto` in every test that touches a token, the exact payoff this pattern has already delivered everywhere else in this project.

### 3.2 Scope, CSRF, and logging

**Scope requested: `repo`.** This is broader than ideal (grants read/write to all repos the user can access, not just read), because classic GitHub OAuth Apps don't offer a narrower read-only-private-repo scope — that finer control is specifically what GitHub Apps exist for (see §5, Trade-off 1). Worth being honest about this rather than glossing over it: this app never uses write access, but the token it holds technically could exercise it.

**CSRF protection and replay.** Handled by the `state` parameter as designed in §2.1/§2.3 — a forged callback without a valid, unexpired, single-use `state` record is rejected outright, and the atomic-consumption fix in §2.1 is what makes "single-use" actually true under concurrent requests, not just true in the common case.

**Log redaction, extended.** The existing `REDACTED_PATHS` list (Milestone 1.5, Task 1) needs new entries once tokens can appear in this milestone's new surfaces: `*.encryptedToken`, `*.authTag`, and — critically — `cloneUrl` itself must never be logged verbatim once it can carry a credential (see §2.4's clone-URL logging fix).

**Error messages never pass through GitHub's raw response.** If the token exchange or an API call to GitHub fails, GitHub's own response body is logged server-side only; the client always receives this project's own sanitized error message — an uncontrolled pass-through surface isn't worth accepting for free, even though GitHub's OAuth error responses are unlikely to contain anything sensitive in practice.

---

## 4. Observability and Rate Limiting

**Extending Milestone 1.75's pattern to this milestone's own work.** Milestone 1.75 established this project's answer to observability: every pipeline stage logs its own duration, plus one summary line. The first version of this design didn't apply that pattern to its own new work — worth fixing here rather than treating observability as something that only applies to already-existing pipelines:

- `"GitHub OAuth connected"` / `"GitHub OAuth disconnected"` log lines with `durationMs`.
- The existing `"Import complete"` summary line gains an `isPrivate: boolean` field, so a private-repo import is distinguishable from a public one in the logs without cross-referencing another collection.

**Rate limiting on the new OAuth-initiating endpoint.** `GET /api/auth/github` is JWT-authenticated, but authentication alone doesn't rate-limit it — nothing otherwise prevents a buggy client (or a confused user double-clicking) from spamming `GitHubOAuthState` record creation. The existing user-based rate limiter pattern (`importRateLimiter`/`chatRateLimiter` from Milestone 1.5) applies here too, for consistency and the same reason those were added.

**Audit-style logging for sensitive actions, without a separate audit subsystem.** A connection being created, a connection being deleted, and a private-repository import are each sensitive enough to deserve a clear, deliberately-named structured log line — not a dedicated audit-log service, which would be real infrastructure this project doesn't need yet (the same reasoning Milestone 1.75 already used to reject a dedicated metrics backend in favor of structured logs).

## 5. Trade-offs, stated explicitly

**1. OAuth App vs. GitHub App.** A GitHub App would let users grant access to *specific* repositories (not "everything you can see") and supports fine-grained, read-only permissions — a genuinely better security posture. It's also genuinely more complex: JWT-signed app authentication with a private key, installation IDs, installation-scoped tokens with their own refresh cycle, and (for full correctness) webhook handling for installation/repository events. For a portfolio project, the classic OAuth App is the right-sized choice — it demonstrates the real OAuth mechanics (authorization code exchange, token storage, CSRF-safe callback handling) without the additional operational surface a GitHub App requires. Worth being able to explain this trade-off precisely in an interview, which is arguably more valuable than having built the more complex option.

**2. Encryption key management.** `TOKEN_ENCRYPTION_KEY` is a single, static, environment-provided key — not a real KMS (AWS KMS, GCP KMS, etc.) with automated rotation. The `keyVersion` field (§2.1, §3.1) makes a *future* rotation additive rather than breaking, but doesn't implement rotation itself. A real production system handling many users' OAuth tokens at real scale would want a managed KMS; a single versioned static key is the right-sized choice here, the same reasoning `JWT_SECRET` already uses.

**3. Repository deletion must cascade to chunks.** Deleting a `Repository` needs to cascade-delete its `Chunk` documents too, or they become permanently orphaned, invisible garbage in the `chunks` collection — a correctness requirement for the new `DELETE /api/repositories/:id` endpoint (§2.2), not optional cleanup.

**4. `githubUserId` uniqueness — a deliberate non-decision, not an oversight.** Whether the same GitHub identity should be preventable from connecting to multiple app accounts is a genuine product question (a shared bot account is a legitimate use case; silent identity confusion between two of this app's users sharing one GitHub login is not). This design deliberately doesn't enforce uniqueness on `githubUserId` — but does index it anyway (§2.1), since it's a natural future lookup path and free to add now, without committing to a uniqueness constraint that might be wrong.

---

## 6. Task Breakdown

Ordered so each task leaves the project working, matching the Milestone 1.5 pattern:

1. **`TokenEncryptor`** (implementing `ITokenEncryptor`, AES-256-GCM with explicit IV/auth-tag/keyVersion handling — the full design in §3.1, not the incomplete version this task started with) + tests — a small, foundational piece everything else depends on, worth getting right and tested in isolation first. **Status: ✅ Complete** — see the README's Milestone 2 section for the full account, including a real bug (a prematurely-required env var) caught by self-review before shipping.
2. **`GitHubConnection` + `GitHubOAuthState` models and repositories.** **Status: ✅ Complete** — see the README's Milestone 2 section for the full account, including a real implementation detail (explicit `$set` vs. ambiguous plain-object update semantics) resolved during self-review.
3. **The OAuth flow itself** (`GET /api/auth/github`, `GET /api/auth/github/callback`, `DELETE /api/auth/github`) — the connect/disconnect lifecycle, without touching the import pipeline yet.
4. **Enable private repos in the existing pipeline** (`GitHubClient`, `GitClonerClient` changes, the log-redaction fix) — this is where private-repo import actually starts working.
5. **Repository management endpoints** (`GET /api/repositories`, `DELETE /api/repositories/:id`, including chunk cascade-delete).

Each task gets the same treatment as every Milestone 1.5 task: rationale, self-review, tests, documentation — one at a time, not all five at once.
