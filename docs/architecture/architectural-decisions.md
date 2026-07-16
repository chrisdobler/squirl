---
title: Architectural Decisions
tags:
  - squirl
  - architecture
  - adr
---

# Architectural Decisions

This is Squirl's consolidated architecture decision record. It records decisions that are already reflected in the repository, including the reason they were made and the constraints they create. It is not a roadmap: proposed work belongs in [[status-tracker]] until a decision is accepted.

## How To Use This Log

- Give each decision a stable number; never renumber old entries.
- Use `Proposed`, `Accepted`, `Deprecated`, or `Superseded by ADR-NNN` as the status.
- Amend an entry only to add evidence or clarify wording. If the decision changes, add a new ADR and supersede the old one.
- Link the owning source and related architecture note so implementation drift is visible.
- Dates below identify when the decision first became evident in the repository, not necessarily when it was first discussed.

## Decision Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [ADR-001](#adr-001--local-first-multi-provider-client) | Local-first, multi-provider client | Accepted | 2026-04-06 |
| [ADR-002](#adr-002--native-esm-react-and-ink-for-the-terminal-ui) | Native ESM, React, and Ink for the terminal UI | Accepted | 2026-04-06 |
| [ADR-003](#adr-003--local-jsonl-history-is-the-shared-conversation-record) | Local JSONL history is the shared conversation record | Superseded by ADR-017 | 2026-04-06 |
| [ADR-004](#adr-004--memory-is-an-optional-asynchronous-retrieval-pipeline) | Memory is an optional asynchronous retrieval pipeline | Accepted | 2026-04-11 |
| [ADR-005](#adr-005--route-local-ai-through-an-openai-compatible-gateway) | Route local AI through an OpenAI-compatible gateway | Accepted | 2026-04-14 |
| [ADR-006](#adr-006--multiple-frontends-share-one-application-runtime-and-data-model) | Multiple frontends share one runtime and data model | Accepted | 2026-06-17 |
| [ADR-007](#adr-007--streaming-events-carry-immutable-message-snapshots) | Streaming events carry immutable message snapshots | Accepted | 2026-06-17 |
| [ADR-008](#adr-008--pipeline-progress-is-ephemeral-and-failures-are-subsystem-specific) | Pipeline progress is ephemeral and failures are subsystem-specific | Accepted | 2026-06-15 |
| [ADR-009](#adr-009--rewind-is-permanent-but-respects-history-ownership) | Rewind is permanent but respects history ownership | Accepted | 2026-06-15 |
| [ADR-010](#adr-010--the-tui-renders-a-fixed-row-viewport) | The TUI renders a fixed-row viewport | Accepted | 2026-06-16 |
| [ADR-011](#adr-011--memory-changes-are-evaluated-in-layers) | Memory changes are evaluated in layers | Accepted | 2026-06-19 |
| [ADR-012](#adr-012--external-coding-agents-join-through-ui-agnostic-adapters) | External coding agents join through UI-agnostic adapters | Accepted | 2026-06-18 |
| [ADR-013](#adr-013--agent-routing-is-explicit-and-bounded-by-default) | Agent routing is explicit and bounded by default | Accepted | 2026-06-18 |
| [ADR-014](#adr-014--web-agent-events-use-the-request-stream-until-persistent-broadcast-exists) | Web agent events use the request stream for now | Superseded by ADR-017 | 2026-06-18 |
| [ADR-015](#adr-015--dependency-health-is-probed-server-side-and-published-with-app-state) | Dependency health is server-side cached app state | Accepted | 2026-06-29 |
| [ADR-016](#adr-016--architecture-documentation-lives-with-the-code) | Architecture documentation lives with the code | Accepted | 2026-07-10 |
| [ADR-017](#adr-017--participant-turns-are-queued-independently-and-web-events-are-persistent) | Participant turns use independent queues and persistent events | Accepted | 2026-07-13 |
| [ADR-018](#adr-018--agent-permissions-use-one-session-scoped-approval-broker) | Agent permissions use one session-scoped approval broker | Accepted | 2026-07-14 |

---

## ADR-001 — Local-first, multi-provider client

**Status:** Superseded by ADR-017
**Date:** 2026-04-06

### Context

Squirl needs to preserve user control while supporting hosted and self-hosted models. Binding the application to one provider would conflict with that goal.

### Decision

Squirl is a local-first client and orchestration layer. It supports OpenAI, Anthropic, and OpenAI-compatible local services behind a shared message, configuration, and streaming model. Durable user state remains local by default.

### Consequences

- Provider-specific behavior is isolated in adapters and configuration rather than UI components.
- Local backends are first-class, but hosted services remain supported.
- Features must not assume that every provider exposes identical metadata, streaming events, or tool behavior.

### Evidence

`src/api.ts`, `src/config.ts`, `src/orchestrator.ts`, and the provider configuration described in the root `README.md`.

## ADR-002 — Native ESM, React, and Ink for the terminal UI

**Status:** Accepted  
**Date:** 2026-04-06

### Context

Ink 5 and `ink-text-input` 6 are ESM packages, and the terminal experience benefits from React's component and state model.

### Decision

The codebase uses native ESM with TypeScript `NodeNext` resolution. Local imports include `.js` extensions, JSX lives in `.tsx` files, and `tsx` is the development runner. The CLI entry remains non-JSX and loads a thin launcher boundary.

### Consequences

- CommonJS patterns and extensionless local imports are not supported.
- Browser and Node boundaries must remain explicit even though both use React.
- New JSX source belongs in `.tsx`; runtime imports must be valid after TypeScript emits JavaScript.

### Evidence

`package.json`, `tsconfig.json`, `src/index.ts`, and `src/launcher.tsx`.

## ADR-003 — Local JSONL history is the shared conversation record

**Status:** Accepted  
**Date:** 2026-04-06

### Context

Conversation continuity must survive restarts, stay inspectable, and be shared by the terminal, web, and Electron experiences without requiring a hosted database.

### Decision

Squirl stores owned conversation history as local JSONL under `~/.squirl/history`. Recent entries live in `current.jsonl`; entries older than the rollover window move to date-based archives. All frontends read and append to this same record.

### Consequences

- History remains portable and human-inspectable.
- Web state must refresh from disk so terminal-originated turns are not missed.
- Tests must use timestamps relative to the current time because loading history performs rollover.
- Concurrent access requires append/reload discipline rather than relying on a long-lived in-memory copy.

### Evidence

`src/history.ts`, `src/app.tsx`, `src/web/runtime.ts`, and `src/web/runtime.test.ts`.

## ADR-004 — Memory is an optional asynchronous retrieval pipeline

**Status:** Accepted  
**Date:** 2026-04-11

### Context

Squirl needs long-term recall without making every chat depend on a particular vector database or blocking the foreground response on indexing work.

### Decision

Completed turn pairs are deterministically chunked and indexed through a background ingest queue. Embedders and vector stores are adapter-backed; Chroma is the durable vector-store implementation and a null store keeps memory optional. During a turn, a meta-LLM extracts one or more search queries, results are embedded, retrieved, ranked, deduplicated, and injected into prompt context with an inline user-visible summary.

### Consequences

- Chat remains usable when indexing is disabled or the vector store is unavailable.
- Deterministic chunk identifiers make backfill and deletion repeatable.
- Retrieval quality depends on both query extraction and ranking, so those stages need separate observability and evaluation.
- Background indexing can lag foreground history and must expose status.

### Evidence

`src/search/ingest-queue.ts`, `src/search/memory-pipeline.ts`, `src/search/embedders/`, `src/search/stores/`, and [[memory-and-eval]].

## ADR-005 — Route local AI through an OpenAI-compatible gateway

**Status:** Accepted  
**Date:** 2026-04-14

### Context

Local models may move between runtimes and hardware. Squirl should not need a provider-specific integration or a direct container address for each model.

### Decision

Squirl talks to local AI through a configured OpenAI-compatible `/v1` endpoint. The requested JSON `model` identifier is the routing contract, and `/v1/models` is used for discovery and diagnosis. The preferred deployment path is direct network access to the gateway, not an application-managed SSH tunnel. A `curl` streaming fallback exists for local reachability cases where Node networking fails while the host can still reach the endpoint.

### Consequences

- Backend placement and model lifecycle can change behind the gateway.
- A saved model name is not proof that the active backend serves it; model-list discovery is authoritative.
- Local transport fallback is intentionally isolated in the API layer.
- Environment-specific gateway addresses belong in user configuration, not in this ADR.

### Evidence

`src/api.ts`, `src/config.ts`, `src/model-config.ts`, and model discovery in `src/web/runtime.ts`.

## ADR-006 — Multiple frontends share one application runtime and data model

**Status:** Accepted  
**Date:** 2026-06-17

### Context

The Ink TUI, browser UI, and Electron shell should behave as views of the same Squirl rather than separate products with divergent history and orchestration.

### Decision

Core orchestration, configuration, message types, context construction, memory, and agent coordination are UI-agnostic. The TUI connects to the orchestrator directly. Web and Electron share `SquirlRuntime`, with Electron hosting the web surface rather than introducing a separate application core.

### Consequences

- New core behavior should be implemented below the UI boundary and surfaced in each frontend as needed.
- Web/Electron state may be cached for presentation, but durable history and configuration remain shared with the terminal.
- UI-only capabilities must be labeled rather than silently treated as universal.

### Evidence

`src/app.tsx`, `src/orchestrator.ts`, `src/web/runtime.ts`, `src/web/renderer.tsx`, `src/electron/`, and [[overall-architecture]].

## ADR-007 — Streaming events carry immutable message snapshots

**Status:** Accepted  
**Date:** 2026-06-17

### Context

Passing the orchestrator's live mutable assistant object to React consumers caused duplicated prefixes when both the producer and consumer mutated or appended to the same content.

### Decision

Orchestrator callbacks receive cloned assistant-message snapshots. Token callbacks include both the delta and the current absolute assistant snapshot. UI consumers replace message content by message ID from the snapshot; they do not reconstruct authoritative content by appending deltas to UI state.

### Consequences

- Streaming consumers can throttle rendering without losing the authoritative response.
- Event payloads contain some repeated content, trading bandwidth for deterministic state.
- Any new frontend or agent bridge must preserve replace-by-ID semantics.

### Evidence

`src/orchestrator.ts`, `src/orchestrator.test.ts`, `src/web/runtime.ts`, and `src/web/runtime.test.ts`.

## ADR-008 — Pipeline progress is ephemeral and failures are subsystem-specific

**Status:** Accepted  
**Date:** 2026-06-15

### Context

Memory lookup, provider connection, model streaming, and tools can each delay a response. Persisting normal stage transitions as chat messages adds noise, while raw SDK errors do not identify the failing subsystem clearly.

### Decision

The foreground turn reports compact ephemeral stages for context, memory query generation, embedding, vector search, model connection, model streaming, and tools. Successful progress stays in status UI and out of history. User-visible failures are normalized and name the responsible subsystem. Network-dependent foreground operations use short bounded timeouts.

### Consequences

- New pipeline stages must wire into status reporting and error normalization.
- History contains conversational outcomes rather than operational chatter.
- Short timeouts favor a responsive UI over waiting indefinitely for a degraded local dependency.

### Evidence

`src/orchestrator.ts`, `src/search/memory-pipeline.ts`, `src/search/status.ts`, `src/web/runtime.ts`, and the status components under `src/components/`.

## ADR-009 — Rewind is permanent but respects history ownership

**Status:** Accepted  
**Date:** 2026-06-15

### Context

Users need to remove later context after a bad turn without corrupting a retained user/assistant exchange or deleting imported source data.

### Decision

Rewind selects a user turn boundary, retains that complete turn pair, and permanently removes only later Squirl-owned history. Matching indexed turn-pair records are deleted where the vector store supports deletion. Imported ChatGPT history is immutable.

### Consequences

- Rewind is a destructive action and requires confirmation in the interactive flow.
- History and vector memory must be cleaned together to avoid recalling removed turns.
- Import provenance is an ownership boundary, not merely presentation metadata.

### Evidence

`src/rewind.ts`, rewind handling in `src/app.tsx`, and `src/history.ts`.

## ADR-010 — The TUI renders a fixed-row viewport

**Status:** Accepted  
**Date:** 2026-06-16

### Context

Rendering the entire Ink message tree and shifting it with negative margins caused header/status flicker and edge artifacts during rapid scrolling.

### Decision

The terminal message list constructs deterministic display rows and renders only the visible fixed-height window. Viewport and scrollbar calculations share the same row counts and offsets. Streaming pins to the bottom unless the user deliberately scrolls away, and resumes pinning when the user returns to the bottom.

### Consequences

- Layout, scrollbar, and streaming-scroll transitions remain in pure testable helpers.
- Mouse input moves by configured fixed line steps rather than velocity-based animation.
- Features such as rewind must clear stale scroll targets when their mode exits.

### Evidence

`src/components/MessageList.tsx`, scroll helpers and tests under `src/`, and rewind integration in `src/app.tsx`.

## ADR-011 — Memory changes are evaluated in layers

**Status:** Accepted  
**Date:** 2026-06-19

### Context

End-to-end answer quality alone does not show whether a memory change helped query extraction, retrieval ranking, or answer construction. Fully live evaluation is also too variable for reliable regression detection.

### Decision

The memory evaluation harness separates query extraction, retrieval metrics, end-to-end `MemoryPipeline` behavior, and judged answer quality into layers. It supports deterministic frozen fixtures for regression testing and explicit live runs for refreshing or validating the real backend. Comparable results are grouped by layer, mode, embedder, and corpus/chunk identity.

### Consequences

- Ranking and chunking changes should be measured before adoption.
- Frozen baselines provide repeatability but must be refreshed deliberately when production embeddings change.
- A small golden set can catch regressions without proving broad quality gains.
- Layer 0 query-extraction evaluation remains a known gap, not an implicit claim of coverage.

### Evidence

`src/search/eval/`, `src/search/eval/README.md`, npm eval scripts in `package.json`, and [[memory-and-eval]].

## ADR-012 — External coding agents join through UI-agnostic adapters

**Status:** Accepted  
**Date:** 2026-06-18

### Context

Claude Code and Codex have different CLI session and stream formats, but both should appear as named participants with the same message/event semantics in every Squirl frontend.

### Decision

The multi-agent core is Node-only and UI-agnostic. `AgentTransport` owns process I/O, provider adapters own CLI session semantics, pure parsers convert native streams to unified `AgentEvent`s, and `GroupChatCoordinator` owns participant routing. Local subprocess transport is implemented; SSH transport remains an explicit stub rather than being embedded in adapters.

### Consequences

- CLI quirks stay inside their adapter rather than leaking into the coordinator or UI.
- Captured stream fixtures can test parser behavior without launching real agents.
- Remote execution can be added at the transport seam if and when its scope is accepted.

### Evidence

`src/agents/`, especially `types.ts`, `coordinator.ts`, `adapters/`, `parse/`, and `transport/`; see [[multi-agent-room]].

## ADR-013 — Agent routing is explicit and bounded by default

**Status:** Accepted  
**Date:** 2026-06-18

### Context

Automatic agent-to-agent handoffs can create unreviewed work, permission expansion, or loops. At the same time, users need a concise way to address a particular participant.

### Decision

Connected participants are addressed through explicit, case-insensitive `@mention`s. Automatic handoff is disabled by default; when enabled it is capped by `maxHops`. Agent CLI permissions remain explicit: Codex defaults to workspace-scoped write access, while Claude defaults to accepting file edits. Read-only/plan and dangerous full-access modes remain explicit options, and Shift+Tab cycles only the safe modes for the selected agent.

### Consequences

- The user remains the default routing authority.
- Mention parsing must resolve connected participant handles before falling through to `@file` context parsing.
- Any broader autonomous mode requires an explicit configuration decision and retains a hard hop bound.

### Evidence

`src/agents/coordinator.ts`, `src/agents/participants.ts`, `src/agents/adapters/`, `src/config.ts`, and coordinator tests.

## ADR-014 — Web agent events use the request stream until persistent broadcast exists

**Status:** Superseded by ADR-017
**Date:** 2026-06-18

### Context

The first multi-agent web implementation could reuse the existing chat request stream. A persistent event channel would add lifecycle, replay, ordering, and multi-client concerns that were not yet required for the synchronous room experience.

### Decision

For the current implementation, `/api/chat` remains open while addressed agent turns complete and emits their events through that request's NDJSON stream. Persistent broadcast is deferred until asynchronous/background agent behavior is implemented.

### Consequences

- A second browser tab does not receive another tab's live turn.
- Background output cannot outlive or independently publish beyond the originating request.
- Persistent event broadcast must be designed before claiming multi-client or asynchronous agent support.

### Evidence

`src/web/server.ts`, `src/web/runtime.ts`, `src/agents/coordinator.ts`, and the documented gaps in [[multi-agent-room]].

## ADR-015 — Dependency health is probed server-side and published with app state

**Status:** Accepted
**Date:** 2026-06-29

### Context

The web/Electron UI needs to distinguish unavailable endpoints from reachable services that do not serve the configured model, without spending tokens or adding a separate client polling system for every dependency.

### Decision

`SquirlRuntime` builds health targets from configuration, runs cheap server-side probes, caches a typed health report, and publishes it through the existing application-state response. Health distinguishes `ok`, `degraded`, `down`, and `unknown`. The browser's existing state poll carries updates; no dependency-specific browser intervals or endpoint are added.

### Consequences

- Credentials and provider-specific checks stay on the server side.
- Model presence can be reported as degraded separately from endpoint reachability.
- Health is currently a web/Electron capability, not a universal TUI contract.
- Probe scheduling follows runtime configuration changes and avoids token-generating checks.

### Evidence

`src/web/health.ts`, health scheduling in `src/web/runtime.ts`, `AppState.health`, and the web renderer.

## ADR-016 — Architecture documentation lives with the code

**Status:** Accepted  
**Date:** 2026-07-10

### Context

Squirl needs a system map, progress view, and durable rationale that evolve with implementation. An external diagram alone would be difficult to review with code or keep synchronized.

### Decision

Architecture documentation is version-controlled Markdown under `docs/architecture`, with Mermaid for diagrams and Obsidian-compatible links for navigation. The pipeline tracker describes current implementation state; this ADR log describes durable choices and rationale. Detailed notes link to source owners instead of duplicating implementation documentation.

### Consequences

- Architectural changes should update diagrams, status, and ADRs in the same change when applicable.
- Percent-complete estimates remain planning signals, not architecture decisions.
- External whiteboards may support exploration, but the repository remains the durable source of truth.

### Evidence

[[README|Squirl Linear Pipeline]], [[overall-architecture]], [[status-tracker]], [[memory-and-eval]], and [[multi-agent-room]].

## ADR-017 — Participant turns are queued independently and web events are persistent

**Status:** Accepted
**Date:** 2026-07-13

### Context

The request-bound stream in ADR-014 made one agent's turn a room-wide lock. It also let Squirl's handoff pipeline label remain visible while an external agent was actually working, and it prevented the user from continuing a conversation with another participant.

### Decision

Postgres is the authoritative room transcript and durable participant-turn queue. Each participant has at most one leased `running` turn while different participants may execute concurrently. Chat submission supplies an idempotency key and transactionally creates the visible user message plus queued turn. A delegated handoff message and its target turn are likewise committed together. The API server is the sole dispatcher; web, Electron, and TUI consume its state and event stream.

### Consequences

- A busy participant accepts durable follow-ups into a visible FIFO instead of blocking the composer.
- Queued turns resume after restart. Expired running leases become `interrupted` and require explicit Retry or Cancel so external side effects are never replayed silently.
- Postgres unavailability fails closed: new sends return `503` and no in-memory or JSONL fallback accepts work.
- Existing JSONL history is imported once and archived; Chroma remains a derived index.
- Concurrent UI updates must identify messages by id instead of assuming the newest message owns the active stream.

### Evidence

`src/persistence/`, `src/agents/durable-turn-scheduler.ts`, `src/web/runtime.ts`, `src/web/server.ts`, and `src/tui/ApiApp.tsx`.

## ADR-018 — Agent permissions use one session-scoped approval broker

**Status:** Accepted
**Date:** 2026-07-14

### Context

Headless Claude, Codex, and PI sessions have different permission protocols. Without a bidirectional host integration, operations that would prompt in their native interfaces are denied or may run with an overly broad static posture.

### Decision

Squirl owns one provider-neutral approval queue with allow-once, narrowly scoped allow-for-session, and deny outcomes. Claude integrates through the Agent SDK, Codex through persistent App Server JSON-RPC, and PI through a bundled blocking extension over its existing RPC UI channel. Agent profiles persist the default posture, but individual grants live only inside the current adapter process.

### Consequences

- Browser reconnects restore pending prompts from runtime state; stale responses are idempotent.
- Stop, interrupt, and reconnect fail pending requests closed and clear session grants.
- Dangerous no-prompt configurations require explicit confirmation and remain excluded from shortcuts.
- Provider suggestions that would persist settings, change modes, or broaden policy are not accepted.

### Evidence

`src/agents/permissions.ts`, the three agent adapters, `src/agents/pi-permission-gate.ts`, and the shared web/TUI interaction renderers.
