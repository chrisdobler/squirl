---
title: Overall Architecture
tags:
  - squirl
  - architecture
  - mermaid
---

# Overall Architecture

```mermaid
flowchart TB
  user["User"]

  subgraph ui["User interfaces"]
    tui["Ink TUI\nsrc/app.tsx"]
    web["React web UI\nsrc/web/renderer.tsx"]
    electron["Electron shell\nsrc/electron/*"]
  end

  subgraph runtime["Shared application runtime"]
    webRuntime["SquirlRuntime\nsrc/web/runtime.ts"]
    orchestrator["Orchestrator\nsrc/orchestrator.ts"]
    history["Local history\nsrc/history.ts"]
    config["Config\n~/.squirl/config.json"]
    commands["Slash commands\nsrc/commands/registry.ts"]
  end

  subgraph chatCore["Chat turn core"]
    context["Context builders\nsystem / directory / files / truncation"]
    modelConfig["Model config and context window"]
    api["Streaming chat API\nsrc/api.ts"]
    toolRegistry["Tool registry\nsrc/tools/registry.ts"]
  end

  subgraph memory["Memory system"]
    ingest["Ingest queue"]
    pipeline["MemoryPipeline"]
    embedder["Embedder"]
    store["Vector store"]
    recall["Recall command"]
  end

  subgraph observability["Progress and observability"]
    pipelineStatus["Query pipeline status"]
    indexStatus["Index status emitter"]
    health["Health lights"]
    evalDashboard["Eval dashboard"]
  end

  subgraph agents["Multi-agent room"]
    coordinator["GroupChatCoordinator"]
    adapters["CLI adapters"]
    participants["Room roster"]
  end

  subgraph providers["Providers and dependencies"]
    hosted["OpenAI / Anthropic"]
    local["Local OpenAI-compatible gateway"]
    chroma["ChromaDB"]
    cliProcesses["claude / codex / pi subprocesses"]
  end

  user --> tui
  user --> web
  web --> webRuntime
  electron --> web
  tui --> orchestrator
  webRuntime --> orchestrator
  webRuntime --> history
  webRuntime --> config
  webRuntime --> commands

  orchestrator --> context
  orchestrator --> modelConfig
  orchestrator --> api
  orchestrator --> toolRegistry
  orchestrator --> pipeline

  api --> hosted
  api --> local
  toolRegistry --> commands

  ingest --> embedder
  ingest --> store
  pipeline --> embedder
  pipeline --> store
  recall --> embedder
  recall --> store
  store --> chroma

  webRuntime --> ingest
  webRuntime --> recall
  webRuntime --> health
  webRuntime --> evalDashboard
  webRuntime --> coordinator

  orchestrator --> pipelineStatus
  ingest --> indexStatus
  health --> hosted
  health --> local
  health --> chroma

  coordinator --> adapters
  coordinator --> participants
  adapters --> cliProcesses
```

## Source Owners

| Area | Primary source |
|---|---|
| TUI chat surface | `src/app.tsx`, `src/components/*` |
| Web/Electron runtime | `src/web/runtime.ts`, `src/web/renderer.tsx`, `src/electron/*` |
| Chat orchestration | `src/orchestrator.ts`, `src/api.ts` |
| Context assembly | `src/context/*` |
| Tools | `src/tools/*`, `src/commands/registry.ts` |
| Memory and indexing | `src/search/*` |
| Eval dashboard | `src/search/eval/*`, `src/web/EvalDashboard.tsx` |
| Multi-agent room | `src/agents/*` |
| Health lights | `src/web/health.ts` |

## Current Reading

The architecture is a shared runtime with multiple frontends. The TUI talks directly to the orchestrator, while the web and Electron surfaces use `SquirlRuntime` as the stateful bridge for config, history, health, evals, agents, and streaming chat events.
