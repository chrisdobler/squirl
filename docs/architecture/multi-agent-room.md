---
title: Multi-Agent Room Architecture
tags:
  - squirl
  - agents
  - architecture
  - mermaid
---

# Multi-Agent Room Architecture

```mermaid
flowchart TB
  user["User message"]
  mentions["parseMentions"]
  runtime["SquirlRuntime.chat"]
  coordinator["GroupChatCoordinator"]

  subgraph participants["Participants"]
    squirl["squirl\nlocal LLM participant"]
    claude["Claude Code agent"]
    codex["Codex agent"]
  end

  subgraph sessions["Agent sessions"]
    claudeAdapter["ClaudeCodeAdapter\npersistent stream-json"]
    codexAdapter["CodexAdapter\nexec / resume"]
    transport["LocalSpawnTransport"]
    ssh["SshTransport\nstub"]
  end

  subgraph events["Unified event stream"]
    parser["CLI stream parsers"]
    agentEvents["AgentEvent"]
    chatEvents["ChatEvent"]
    roster["Room roster and status"]
    history["Local history"]
  end

  user --> runtime --> mentions
  mentions --> coordinator
  coordinator --> squirl
  coordinator --> claude
  coordinator --> codex

  squirl --> runtime
  claude --> claudeAdapter
  codex --> codexAdapter
  claudeAdapter --> transport
  codexAdapter --> transport
  transport -. future .-> ssh

  claudeAdapter --> parser
  codexAdapter --> parser
  parser --> agentEvents
  agentEvents --> chatEvents
  agentEvents --> roster
  chatEvents --> history

  coordinator -.optional bounded auto-handoff.-> coordinator
```

## Completion Signals

| Slice | Status | Completion | Notes |
|---|---:|---:|---|
| Participant model | In place | 85% | User, local LLM, and external agents share a routing model. |
| Claude/Codex adapters | In place | 70% | Codex live path has been validated; Claude uses captured fixtures and tests plus adapter implementation. |
| Safety defaults | In place | 80% | Auto-handoff off by default, hop limit, conservative CLI permission defaults. |
| UI room roster | In place | 75% | TUI and web surfaces expose participants and status. |
| Async broadcast | Gap | 35% | Web uses the existing per-request stream; no persistent event broadcast yet. |
| SSH transport | Stub | 10% | Interface exists but remote execution is not implemented. |

## Known Gaps

- A second web tab does not receive turns from another tab.
- Truly async/background agent output needs a persistent event channel such as `GET /api/events`.
- SSH-backed agents are represented by a transport stub, not a working remote path.
