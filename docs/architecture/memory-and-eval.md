---
title: Memory And Eval Architecture
tags:
  - squirl
  - memory
  - eval
  - mermaid
---

# Memory And Eval Architecture

```mermaid
flowchart TB
  subgraph live["Live memory path"]
    turn["Completed Squirl turn pair"]
    queue["IngestQueue"]
    chunks["buildChunkText"]
    embed["Embedder\nOpenAI or local"]
    store["VectorStore\nChroma or null"]
  end

  subgraph retrieval["Retrieval during chat"]
    userMsg["User message + history"]
    queryLLM["Meta LLM\nextractSearchQueries"]
    queries["Search queries"]
    queryEmbed["Embed queries"]
    vectorQuery["Vector DB query"]
    rank["rankResults"]
    memoryMsg["Memory system message\n+ inline display"]
    orchestrator["Orchestrator prompt assembly"]
  end

  subgraph evals["Evaluation system"]
    corpus["Golden corpus"]
    cases["Golden cases"]
    harness["Eval harness"]
    layer1["Layer 1\nretrieval metrics"]
    layer2["Layer 2\nend-to-end MemoryPipeline"]
    layer3["Layer 3\nanswer quality judge"]
    history["~/.squirl/eval/history.jsonl"]
    dashboard["Web/Electron eval panel"]
    monitor["Optional auto-monitor"]
  end

  turn --> queue --> chunks --> embed --> store

  userMsg --> queryLLM --> queries --> queryEmbed --> vectorQuery --> rank --> memoryMsg --> orchestrator
  queryEmbed --> embed
  vectorQuery --> store

  corpus --> harness
  cases --> harness
  harness --> layer1
  harness --> layer2
  harness --> layer3
  layer1 --> history
  layer2 --> history
  layer3 --> history
  history --> dashboard
  monitor --> harness
  dashboard --> harness
```

## Completion Signals

| Slice | Status | Completion | Notes |
|---|---:|---:|---|
| Turn-pair ingestion and indexing | In place | 85% | Queue, chunking, embedders, stores, status emitter, and backfill path exist. |
| Retrieval pipeline | In place | 80% | Query extraction, embedding, vector query, ranking, prompt injection, and inline display exist. |
| Eval layers | Mostly in place | 80% | Layers 1-3 exist; Layer 0 query-extraction quality remains unbuilt. |
| Eval dashboard | In place | 75% | Web panel, history trends, run button, and Layer 3 live log exist. |
| Auto-monitor | In place | 70% | Timer exists and is config-gated; alerting and richer surfacing are still light. |

## Known Gaps

- Layer 0 eval coverage for query extraction quality is not built.
- The golden set is intentionally small; it is strong for catching regressions and weaker for proving broad improvements.
- Memory quality and runtime health are visible, but they are not yet consolidated into one architecture progress screen.

