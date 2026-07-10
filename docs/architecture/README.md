---
title: Squirl Architecture Dashboard
tags:
  - squirl
  - architecture
  - status
---

# Squirl Architecture Dashboard

This folder is an Obsidian-friendly architecture workspace. Open the repo, or this `docs/architecture` folder, as an Obsidian vault to browse the diagrams and update the implementation status as the system changes.

## Navigation

- [[overall-architecture]] - system map across the TUI, web/Electron runtime, model providers, memory, tools, evals, health, and multi-agent room.
- [[memory-and-eval]] - memory indexing, retrieval, eval layers, dashboard, and auto-monitoring.
- [[multi-agent-room]] - @mention routing, subprocess adapters, participant status, and known broadcast limitations.
- [[status-tracker]] - current completion estimates, blockers, and next steps.

## Architecture At A Glance

```mermaid
flowchart LR
  user["User"] --> surfaces["Squirl surfaces"]

  subgraph uiSurfaces["Squirl surfaces"]
    tui["Ink TUI"]
    web["React web UI"]
    electron["Electron shell"]
  end

  surfaces --> tui
  surfaces --> web
  surfaces --> electron
  tui --> runtime["Shared runtime and orchestrator"]
  web --> runtime
  electron --> runtime
  runtime --> providers["Model providers"]
  runtime --> memory["Memory and retrieval"]
  runtime --> tools["Built-in tools"]
  runtime --> agents["Multi-agent room"]
  runtime --> evals["Eval dashboard and monitor"]
  runtime --> health["Dependency health lights"]

  providers --> hosted["OpenAI / Anthropic"]
  providers --> local["Local OpenAI-compatible gateway"]
  memory --> vector["Chroma / null vector store"]
  agents --> clis["Claude Code / Codex CLIs"]
```

## Operating Rules

- Keep Mermaid diagrams close to the real code paths; avoid adding future components to the diagram until there is a concrete implementation plan or code.
- Treat percentages in [[status-tracker]] as planning estimates, not quality scores.
- When an architecture area changes, update both its diagram note and the tracker row in the same work pass.
- Prefer short notes with links to source owners over long copied explanations.
