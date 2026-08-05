# Milestone 2 Design Review — Principal Engineer Pass

**Stance:** this review's job is to find reasons to reject the design, not confirm it. Every section below either finds a real gap or explicitly confirms a decision holds up under scrutiny — no section is skipped as "obviously fine."

---

## 1. OAuth Architecture

**State parameter handling — a real concurrency bug.** The original design says "look up `state` → recover userId → ... → delete the consumed record." Written as two separate steps (find, then delete), this is a **TOCTOU race**: two concurrent requests to the callback with the same `state` (a replayed or duplicated callback, whether malicious or just a browser retry) could both pass the lookup before either completes the delete, both proceeding to complete the OAuth flow. **Fix: the state lookup must be a single atomic `findOneAndDelete`, not a find followed by a delete.** This is the same class of bug this project already knows to watch for — it's structurally identical to the Mongoose index-timing race from Day 3-4, just in a different spot.

**Reconnection is undesigned.** The original design specifies a unique index on `GitHubConnection.userId` but never specifies what happens when a user who's already connected goes through the flow again (reconnecting after revoking on GitHub's side, or re-granting after a scope change). As written, this hits a duplicate-key error on the second connection attempt. **Fix: the connection step must be an explicit upsert (`findOneAndUpdate` with `upsert: true`), not an insert.**

**Retry/timeout on the token exchange is missing.** The token exchange (`POST github.com/login/oauth/access_token`) is a single-shot, user-facing, synchronous call — if it times out or hits a transient failure, the entire OAuth flow fails and the user has to redo GitHub's own authorize page from scratch. This is a real difference from the import pipeline's background retries: there's a human waiting in a browser tab. **Fix: a short retry (2 attempts, brief backoff) specifically on this one call**, with a clear, actionable error if both attempts fail — not a generic 500.

**Token invalidity at time of use is unhandled.** A GitHub token can become invalid between validation and use (org policy changes, user revokes access on GitHub's side, an admin-enforced token expiration). The design doesn't specify how this surfaces. **Fix: a 401 from GitHub during an import must translate into a specific, actionable error** ("Your GitHub connection is no longer valid — please reconnect") rather than a generic import failure indistinguishable from a network blip.

**What holds up, confirmed rather than assumed:**
- The `state`-based identity resolution for a stateless-JWT API is correct and necessary, not over-engineered — there is genuinely no other way to know which user a cookie-less browser redirect belongs to.
- No open-redirect surface exists — the design never accepts a client-supplied redirect target; GitHub itself validates `redirect_uri` against the app's registration.
- Disconnecting GitHub correctly leaves already-imported repositories' chunks intact (chat doesn't need live GitHub access) while blocking new imports — this was implicit in the original design and should be stated as intentional, not left ambiguous.

---

## 2. Token Encryption

**This section had the most real gaps, and deserves the most rework.**

**IV (nonce) handling was unspecified.** AES-GCM requires a **unique** IV per encryption under a given key — reusing an IV catastrophically breaks GCM's security guarantees (it's not a minor detail; IV reuse under GCM can leak the authentication key entirely). The original design never said how the IV is generated or where it's stored. **Fix:** generate a fresh random 12-byte IV per encryption call (Node's `crypto.randomBytes(12)`), store it alongside the ciphertext (not secret, just needs to be unique and available for decryption).

**Auth tag storage was unspecified.** GCM produces a 16-byte authentication tag that must be stored and verified on decrypt, or the encryption provides no tamper protection at all — it degrades to plain confidentiality with no integrity guarantee. **Fix:** explicitly store `{iv, authTag, ciphertext}` as three distinct fields (or one delimited string) — not just "ciphertext" as the original design vaguely described it.

**Key format was unspecified.** `TOKEN_ENCRYPTION_KEY` needs a precise, documented format — a base64-encoded 32-byte value (`openssl rand -base64 32`, the exact same pattern already used for `JWT_SECRET`), validated at startup by the existing Zod env schema (fail fast on a malformed key, not on the first encryption attempt in production).

**No design for future key rotation.** The original design named this as an accepted limitation but didn't design *for* the possibility, even minimally. **Fix, cheap to add now, expensive to retrofit later:** store a `keyVersion` field alongside every encrypted value. With only one key today, this costs nothing. Without it, a future rotation requires either a flag-day cutover (every stored token breaks simultaneously) or a painful schema migration under time pressure.

**Encryption was not abstracted behind an interface.** This is a real, direct inconsistency with the rest of the codebase — `IEmbeddingProvider`, `IChatCompletionProvider`, `IGitHubClient` (introduced in Milestone 1.75 specifically to fix a testability gap) all exist for exactly this reason. **Fix: a `TokenEncryptor` class implementing `ITokenEncryptor`** (`encrypt(plaintext): EncryptedValue`, `decrypt(value: EncryptedValue): string`), constructed once in the composition root. This isn't ceremony — it's what lets the OAuth callback handler and the repository-import pipeline be tested with a fake encryptor instead of exercising real Node `crypto` in every test that touches a token, the same payoff this pattern has already delivered everywhere else in this project.

---

## 3. Database Design

**`GitHubConnection`:**
- Unique index on `userId`: correct, but the code path storing it must be an upsert per the fix in §1.
- **Missing `keyVersion` field** — added per §2.
- **No index on `githubUserId`.** Whether to *prevent* the same GitHub identity being connected to multiple app accounts is a real product decision (a shared bot account is a legitimate use case; silent identity confusion is not) — the design should state this as a **deliberate non-decision**, not a silent gap: allowed for now, with an index on `githubUserId` added anyway (even without a uniqueness constraint) since it's a natural future lookup path and free to add now.
- **Cascading delete on user account deletion is undesignable right now** — because no user-account-deletion feature exists anywhere in this project yet. Correctly out of scope for Milestone 2, but the model should be built so that relationship is a straightforward addition later (a plain `userId` foreign-key-style reference, which it already is).

**`GitHubOAuthState`:**
- TTL index: correct in principle, but the fix in §1 (atomic `findOneAndDelete`) is what actually prevents reuse — the TTL index alone only bounds *how long* a stale record could be replayed, not whether concurrent replay within that window succeeds.
- Multiple concurrent flows for the same user (two browser tabs) were correctly identified as a non-issue in the original design — both would legitimately reconnect the same account. Confirmed, not revised.

---

## 4. Repository Pipeline

**A real SSRF question, now answered with evidence, not assumed.** Once a real credential is embedded in a clone URL, any gap in validating that the URL actually points to `github.com` becomes higher-stakes than before. Checked: `GitHubClient`'s existing `GITHUB_URL_PATTERN` regex (`^https:\/\/github\.com\/...`) already strictly validates this, and as long as the authenticated clone URL is constructed from the **validated, parsed** `owner`/`repo` values — never by re-interpolating raw user input — this holds. This needs to be stated explicitly in the design as a checked constraint, not left implicit, precisely because the consequence of getting it wrong just became more severe (a leaked user credential, not just an unexpected clone target).

**Shell injection: checked directly against `simple-git`'s actual implementation, not assumed.** `simple-git` calls Node's `child_process.spawn(command, args, options)` — a separate command and an **argv array**, not a single shell string. Arguments (including a clone URL with an embedded token) are passed directly to the `git` binary; no shell ever interprets them. Confirmed via `simple-git`'s own source, not assumed from its documentation.

**Malicious repository content and path traversal:** unaffected by this milestone. Chunking never executes repository content, and file-walking logic doesn't change based on a repository's visibility. Worth a one-line confirmation rather than silent omission, since the review explicitly asked about it.

**Cleanup on failure:** the existing `finally { await cloned.cleanup() }` pattern already handles this correctly regardless of whether the repo was public or private — no new gap introduced here.

---

## 5. Security Review

**A real gap: which user's token gets used for an import must be resolved from the authenticated caller's own JWT, never from any client-supplied value.** The design implies this but never states it as an explicit constraint. Worth being explicit: `POST /api/repositories` must look up the `GitHubConnection` via `req.userId` (from the verified JWT) exclusively — there must be no code path where a token is selected via a repository ID, a request body field, or any other client-influenced value. This is the specific line that prevents one user's private-repo access from ever being reachable through another user's request.

**Secret exposure through pass-through error messages.** If GitHub's own OAuth error response is ever returned to our client verbatim, that's an uncontrolled surface — unlikely to contain a secret, but not a risk worth accepting for free. **Fix:** GitHub's raw response body is logged server-side only; the client always receives our own sanitized error message.

**Everything else the review asked about — replay attacks, CSRF, token leakage, privilege escalation, repository ownership validation — is addressed by the fixes above**, not a separate, new category of issue. Worth stating plainly rather than padding this section with restated points.

---

## 6. Production Readiness

**A real, notable gap: this design didn't extend Milestone 1.75's own observability pattern to itself.** Milestone 1.75 established "every pipeline stage logs its own duration, plus one summary line" as this project's answer to observability — and then the Milestone 2 design didn't apply that pattern to its own new work at all. **Fix:** `"GitHub OAuth connected"` / `"GitHub OAuth disconnected"` log lines with `durationMs`, and the private-repo path through the import pipeline should note `isPrivate: true` in its existing "Import complete" summary — cheap to add, and inconsistent not to.

**Missing rate limiting on the new OAuth-initiating endpoint.** `GET /api/auth/github` is JWT-authenticated, but authentication alone doesn't rate-limit it — nothing currently prevents a buggy client (or a user) from spamming state-record creation. **Fix:** apply the existing user-based rate limiter pattern here too, consistent with how `importRateLimiter`/`chatRateLimiter` were applied in Milestone 1.5.

**Audit logging, specifically requested by this review:** connection created, connection deleted, and private-repository import should each produce a clear, structured log line — not a separate audit subsystem (that would be real infrastructure this project doesn't need yet, the same reasoning Milestone 1.75 already used to reject a dedicated metrics backend), just a deliberate, named log line for each sensitive action rather than an incidental one.

---

## 7. Interview Review

**What would hold up well under questioning:**
- The state-based identity resolution for a stateless-JWT system is a genuinely good answer to "how did you handle OAuth without sessions" — it's a real constraint this project actually has (not a contrived one for interview purposes), and the design's answer to it is correct.
- "Why OAuth App, not GitHub App" has a real, defensible answer now (§4 of the original design), and being able to also explain precisely what a GitHub App would have bought instead (fine-grained per-repo consent, read-only scoping) is a stronger answer than not knowing the alternative existed.
- The SSRF and shell-injection questions were answered with evidence from this project's actual dependency source, not "we assume it's fine" — that difference is exactly what separates a senior answer from a junior one in an interview setting.

**What a strong interviewer would immediately probe, and now has real answers for post-revision:**
- *"Walk me through IV handling in your encryption."* → Fresh 12-byte IV per encryption via `crypto.randomBytes`, stored alongside ciphertext, never reused — and explain *why* reuse is catastrophic for GCM specifically (key-recovery, not just reduced randomness).
- *"What happens if two requests hit your OAuth callback with the same state at the same time?"* → Atomic `findOneAndDelete`, not find-then-delete — and being able to name this as the same *class* of bug as an earlier real one in this project (the Day 3-4 index race) shows pattern recognition, not just a one-off fix.
- *"How would you rotate your encryption key?"* → `keyVersion` stored per record today, even with only one key in use, specifically to make a future rotation an additive change instead of a breaking one.

**What they'd likely push on further, without a fully satisfying answer:** whether a single static encryption key (however well-versioned) is a mature-enough answer versus a real KMS — the honest answer is "no, this is a portfolio-appropriate simplification," and saying that plainly is a better interview answer than pretending otherwise.

---

## 8. Final Decision

**B) The design is good but should be improved before implementation.**

The core architecture — OAuth App choice, state-based identity resolution, encryption-at-rest for the token — was sound from the start. But this review found real, concrete gaps, not stylistic nitpicks: a genuine concurrency bug (state lookup race), an incomplete encryption design (IV/auth-tag/key-format all unspecified), a missing abstraction inconsistent with the rest of the codebase, and a production-readiness gap where this design didn't apply lessons this project had already learned one milestone earlier.

**Priority-ordered fixes required before implementation:**

1. Atomic `findOneAndDelete` for OAuth state consumption (real concurrency bug)
2. Complete the encryption design: IV generation/storage, auth tag storage, precise key format, `keyVersion` field
3. Abstract encryption behind `ITokenEncryptor`/`TokenEncryptor`, consistent with the rest of the codebase
4. Upsert (not insert) semantics for `GitHubConnection`
5. Retry + timeout handling on the token exchange call
6. Explicit handling for a token that's become invalid between validation and use
7. Extend Milestone 1.75's observability pattern to the OAuth flow and private-repo imports
8. Apply rate limiting to `GET /api/auth/github`
9. Explicit statement (not silent omission) of the SSRF/shell-injection findings and the `githubUserId` non-decision, in the design document itself

Updating the design document now to incorporate all nine fixes. Implementation starts only once that update is in place — not before.
