# Milestone 3b Design — Developer Experience Interface

The backend is frozen, per instruction — nothing here proposes a backend change. Every data source below is something `apps/api` already exposes today. One real tension between that constraint and a stated UI requirement is surfaced explicitly in §7, not silently worked around.

**A note on reconciliation, kept here for a clear record rather than left only in chat history:** a "project constitution" document was pasted mid-design describing a different backend stack entirely (FastAPI/Python, PostgreSQL+pgvector, Ollama, GitPython) than what actually exists and is live (Express/TypeScript/Node, MongoDB Atlas+`$vectorSearch`, Groq, `simple-git`). Confirmed explicitly: **the real backend stays as-is** — that document was pasted in error, not a genuine request to discard six completed, tested, deployed milestones. Its Core Philosophy section (deterministic-before-AI, provenance on every fact, single-responsibility layers, discover-once-reuse-forever) is worth noting as an accurate *description* of what the real backend already does, not a new principle being adopted — the real `RepositoryIntelligencePipeline`, `ArchitectureIntelligenceEngine`, and four-way router already embody every one of those principles. Its frontend stack and layout matched what's designed below already. One genuinely new, good idea from it *is* incorporated: the **Frontend Orchestrator rule**, §3.1 below.

---

## 1. Philosophy, made concrete

"Information first, AI second" isn't just a tagline here — it maps onto two specific, enforced UI rules:
- **A node's structural facts render immediately on selection, from data already fetched.** The AI panel is a separate, deliberate action (typing a question), never auto-triggered by selection. Clicking a node should never silently fire an LLM call.
- **Every answer states its own provenance.** A Pure Graph/Intelligence answer is visually and textually marked "computed directly, no AI involved" — the frontend surfacing the exact same "LLM explains, never discovers" principle the backend design already enforces server-side, made visible, not just true.

---

## 2. Application Shell

Two genuinely separate states, one persistent shell for the authenticated one:

- **`/login`, `/register`** — minimal, standalone (pre-authentication has no "workspace" to persist).
- **`/workspace/:repositoryId?`** — one persistent layout (sidebar + center + inspector) that never unmounts as the user moves between repositories. The `:repositoryId` param changes; the shell doesn't remount - this is what makes deep-linking to a specific repository's graph possible (bookmark it, share it) while still honestly being "one persistent workspace," not a page reload per repo.

**Layout:**
- **Left sidebar** - repository list (from `GET /api/repositories`), an import form, and the search trigger (Cmd+K / Ctrl+K).
- **Center** - the React Flow graph, always the primary surface.
- **Right inspector** - contextual: repository overview when nothing's selected, node details + AI interaction when something is.

---

## 3. State Management - the real split, and why

- **TanStack Query - server state.** Repository list, a repository's graph (`GET /:id/graph`), analysis results (`GET /:id/graph/analysis/:algorithm`) - anything fetched, cached, and potentially stale. Query keys scoped by `repositoryId` so switching repositories in the sidebar doesn't require manual cache invalidation.
- **Zustand - client/UI state.** Selected node id, hover state, sidebar collapsed/expanded, search palette open/closed, and the auth token itself (persisted via Zustand's `persist` middleware to `localStorage` - worth stating plainly: this project's artifact guidance forbids `localStorage`, but this is a real, standalone codebase you'll run and deploy yourself, not a claude.ai artifact, and the API already hands back bearer tokens for a client to manage itself, so this is the consistent, standard choice, not a shortcut).

This split is deliberate, not arbitrary: conflating "data from the server" with "local UI state" in one store is exactly the kind of unnecessary complexity this project's own discipline argues against elsewhere - two tools, each doing the one job it's actually good at.

### 3.1 The Frontend Orchestrator rule

**React components never coordinate multiple API calls themselves.** A component receives a single, already-composed ViewModel from a dedicated orchestrator hook; it renders, it doesn't fetch-and-combine. This isn't a stylistic preference - it's the concrete answer to a real complexity §7 already surfaces: the Hybrid/Semantic AI panel genuinely needs *two* real requests (a `dependency-analysis` call for Graph Facts, a streaming `ask` call for the explanation) composed into one coherent view. Without this rule, that composition logic would live inside a component, tangled with rendering concerns. With it:

- `useNodeInspector(nodeId)` - an orchestrator hook wrapping the TanStack Query calls needed for structural info (type, provenance, direct dependencies) and returning one clean `{ node, dependencies, isLoading, error }` shape.
- `useAskQuestion(repositoryId, nodeId?)` - orchestrates the classify-then-branch logic itself: calls `ask` first to learn the category; for Pure Graph/Intelligence, returns the result directly; for Hybrid/Semantic, fires the *second* `dependency-analysis` call in parallel with opening the SSE stream, and exposes one unified `{ category, graphFacts, streamedText, citations, isStreaming, error }` ViewModel. The component consuming this never knows two requests happened - it renders one shape, always.

This is where the TanStack Query / Zustand split and the Orchestrator rule reinforce each other: orchestrator hooks are the *only* place that call `useQuery`/manage the SSE connection directly: components consume orchestrator hooks, never the underlying data-fetching primitives themselves.

---

## 4. Graph Rendering - React Flow + ELK.js, and the one real design decision within it

**The graph has two genuinely different kinds of edges, and they should not be treated the same way by the layout algorithm.** `contains` edges form a real, clean hierarchy (repository -> folder -> file -> symbol) - exactly what ELK's layered algorithm is built for. `imports`/`calls`/`defines` edges are cross-cutting relationships that don't respect that hierarchy at all; feeding them into the same layout computation would fight the hierarchy and likely produce a tangled, less legible result.

**Decision: only `contains` edges drive ELK's layout computation.** Every other edge type is still rendered - as a visual connection between the resulting positions - but never influences where a node is placed. This gives the default view a clean, genuinely tree-like architecture at a glance, with cross-cutting relationships visible as lines crossing between branches - closer to what a real "repository architecture" tool should look like than a single undifferentiated force-directed mess.

**Node styling, directly surfacing the backend's own data model, not inventing new visual language:**
- Color/icon by `type` (file, folder, class, service, route, dbModel, etc.).
- **A dashed border for `certainty: 'inferred'` nodes, solid for `deterministic`** - the exact structural-vs-inferred distinction the whole backend design was built around, made visible on the node itself, not just buried in a details panel.
- Nodes involved in a detected cycle get a distinct highlight color (the `cycle-detection` algorithm's result, fetched once per repository selection via TanStack Query, cached).

---

## 5. Interaction Design

**Hover** - highlights incoming/outgoing edges and shows a quick-metrics tooltip. Computed client-side, instantly, from already-fetched edge data (direct edge counts) - no API call on hover, which is what "fast interactions" actually requires; a network round-trip on every hover would violate that principle immediately.

**Click/select** - centers the graph on the node (React Flow's `fitView`/`setCenter`), opens the inspector, and populates it in the stated priority order:
1. **Structural information first** - type, provenance, direct dependencies (fetched via `GET /:id/graph/analysis/dependency-analysis?nodeId=...`, a real, already-existing endpoint from Task 4).
2. **AI explanation second** - only once the user actually types a question. Never auto-fetched on select.

**Search (Cmd+K)** - a VS Code/Cursor-style command palette. Client-side fuzzy search over the already-fetched graph's node labels/types/paths (the whole graph is already loaded once fetched - no reason to hit the API again for search). Selecting a result focuses the graph, selects the node, and opens the inspector - the same sequence a click produces, just triggered from search.

---

## 6. Repository Overview (Inspector's default state, nothing selected)

Every metric here is either a client-side count over already-fetched node data, or one real, already-existing algorithm call - nothing new required from the backend:

| Metric | Source |
|---|---|
| File / folder / service / route / dbModel / package counts | Client-side groupBy(type) over the fetched graph's nodes |
| Cycle count | `GET /:id/graph/analysis/cycle-detection`, fetched once per repository, cached |
| "Health" signal: % of nodes inferred vs deterministic | Client-side, from the same already-fetched node data - a genuine, honest "how much of this graph is confident versus best-effort" signal, not an invented metric |

---

## 7. The AI Interaction Panel - and the real tension worth surfacing before freezing this

The requirement is to clearly distinguish Graph Facts, Intelligence Results, Retrieved Context, and AI Explanation. Checked directly against the real backend code before designing this: **`POST /:id/graph/ask`'s SSE stream sends only `{token: string}` events** - the LLM's raw prose, with citations embedded in the text (`[filepath:startLine-endLine]`), exactly like existing chat. It does not separately expose which graph facts or which retrieved chunks fed the prompt. That's a real, checked constraint, not an assumption.

**Given the backend is frozen, the honest resolution is two calls, not one:**

- **For Pure Graph / Intelligence questions**: the single `ask` response is the graph facts/intelligence result directly (`{category, algorithm, result}`, no streaming). The panel shows exactly this, labeled plainly, with an explicit "No AI was used - computed directly" indicator. This case has no tension at all; the backend already returns exactly the structured data needed.
- **For Hybrid / Pure Semantic questions**: the frontend makes its own, separate, already-existing call to `GET /:id/graph/analysis/dependency-analysis` (using the same `nodeId`/`targetNodeId` the user provided) to populate a genuine "Graph Facts" section - the same real data the backend used internally, just fetched independently rather than exposed through the ask response. The "Retrieved Context" section is populated by parsing citations out of the finished streamed text (the same `extractCitations` pattern existing chat already uses) - shown honestly as "sources referenced in this answer," not claimed to be the complete raw retrieval set, since that's genuinely not available without a backend change this design isn't proposing.

This is worth confirming before implementation starts: it means the Hybrid/Semantic panel makes two real network requests instead of one, and its "Graph Facts" section reflects a live, independently-computed answer rather than a value literally extracted from what the LLM was given - which will usually agree, but isn't structurally guaranteed to. Flagging this now, not discovering it mid-build.

---

## 8. Visual Design

Dark theme only. shadcn/ui components on Tailwind, matching the Cursor/Linear/GitHub/Vercel/Raycast reference points - restrained, information-dense, no decorative chrome. Framer Motion reserved for genuinely subtle transitions (panel open/close, node selection highlight) - never for anything that would make the interface feel slower to use, which would directly contradict "fast interactions" as a stated principle.

---

## 9. Task Breakdown

1. **Scaffold + auth** - Vite/React/TypeScript/Tailwind/shadcn setup, login/register, Zustand auth store with the existing refresh-token flow wired in.
2. **Workspace shell + repository list** - sidebar, import form, the persistent layout itself, routing.
3. **Graph rendering** - React Flow + ELK.js integration, the contains-only layout decision, node styling by type/certainty/cycle membership.
4. **Interaction layer** - hover highlighting, click/select/center/inspector, the command-palette search.
5. **AI panel** - both response shapes (instant JSON, SSE stream), the two-call Hybrid/Semantic design from Section 7, citation parsing.

Same process as every task in this project - rationale, self-review, tests where genuinely meaningful for frontend code, documentation, one task at a time.

---

Confirming before I freeze this and start Task 1 — one thing resolved, one thing still open:

- **Resolved**: the backend stays exactly as-is (Node/Express/TypeScript/MongoDB/Groq); the pasted constitution document doesn't apply to the backend, only its Frontend Orchestrator idea was incorporated (§3.1).
- **Still open**: does the §7 resolution work for you — two real network calls for Hybrid/Semantic questions (a separate `dependency-analysis` call for Graph Facts, since the backend doesn't expose that data separately from the streamed answer), rather than one? This was asked before the constitution document appeared and hasn't been directly confirmed yet.
