# End-to-End Browser Tests

Real browser automation (Playwright) against the real application - the actual flagship demo chain, not a simulation of it.

## IMPORTANT: authored without ever running

Every file in this directory was written and type-checked carefully, but never actually executed - the sandbox this was built in cannot download a real browser binary (cdn.playwright.dev is not in its allowed network egress, confirmed directly by trying, not assumed). This is a materially bigger gap than earlier Milestone 4 tasks: for the smoke test, PowerShell code could at least be checked for structural soundness by other means; here, there is no way to verify these tests actually pass, actually find real elements, or actually complete without running them for real. Expect a genuine debugging cycle, the same as the smoke test's - please run these and report back exactly what happens, errors included.

## What's covered

- flagship-journey.spec.ts - the real demo chain: login -> repository list -> graph loads -> node selection -> Inspector opens -> Pure Graph question (deterministic) -> Hybrid/Semantic question (real streamed AI answer) -> verifying the UI correctly distinguishes "Computed directly" from "AI-generated"
- regression.spec.ts - unauthenticated workspace access (real redirect), a graph-loading failure (mocked response - an explicitly permitted exception for isolated failure testing, since reliably forcing a real backend failure any other way would be flaky)
- api-setup.ts - real API-based test fixtures (register, import, wait for real readiness), reusing the exact same verified patterns as the Task 1 evaluation harness and the Task 2 smoke test, not reinvented

## Setup, before running for the first time

```bash
cd apps/web
npx playwright install chromium
```

This downloads a real Chromium binary - something this sandbox could not do, but should work normally on your own machine with real internet access.

## Running locally

```bash
# Backend running separately, same convention as every other script in this project:
npm run dev:api

# Then, from apps/web:
npm run test:e2e
```

The frontend dev server starts automatically (configured in playwright.config.ts). The backend does not - same convention as the smoke test and eval harness, since it has real, stateful dependencies (MongoDB, GROQ_API_KEY) this config can't safely assume exist.

The Hybrid/Semantic AI test checks for a real GROQ_API_KEY in the environment and explicitly skips itself (not silently, with a clear reason shown in the test report) if it's absent.

## CI

A new e2e job in .github/workflows/ci.yml, gated on secrets.GROQ_API_KEY being configured. This gate exists for a real, verified reason, not caution for its own sake: the backend's own config schema requires GROQ_API_KEY unconditionally just to start (confirmed directly in apps/api/src/config/env.ts, not assumed) - without it, no E2E test could run at all, regardless of which one actually needs the LLM. If the secret isn't configured, the whole job is skipped visibly in the GitHub Actions UI, not fabricated as green.

A real uncertainty, stated honestly rather than hidden: the if: ${{ secrets.GROQ_API_KEY != '' }} gate is a documented, commonly-used GitHub Actions pattern, and it's expected to work correctly - but it has not been verified running in this project's actual GitHub Actions environment. If it behaves unexpectedly (the job always skips even with the secret configured, or always attempts to run without it), that's the first thing to check.

## Adding the secret, if you want CI to actually run E2E tests

Repository -> Settings -> Secrets and variables -> Actions -> New repository secret -> name it GROQ_API_KEY with your real key. Without this, test-api and test-web still run and gate merges normally - only the e2e job is affected.

## Selectors

A small number of data-testid attributes were added directly to the app (RepositoryListItem, Inspector, GraphNode, and each answer entry, which also carries a data-status attribute for waiting on real state transitions like streaming -> complete) - only where genuine disambiguation was needed. The login form already had proper Label associations, so getByLabel() works directly there without any additional markup.
