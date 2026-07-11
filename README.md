<p align="center">
  <img src="./assets/squirl_logo_readme.png" width="200"/>
</p>

<h1 align="center">squirl</h1>

<p align="center">
  A personal continuity layer for memory and multi-agent work.<br/>
  <em>One shared room connecting how you think with the agents doing the work.</em>
</p>

<p align="center">
  <img alt="demo" src="./assets/demo.gif" />
</p>

---

## Why squirl?

Work spread across models and specialized agents quickly loses continuity. Decisions,
preferences, unresolved threads, and the original intent become fragmented across chats.

**squirl is different:**
- 🧠 Recalls relevant context from prior conversations
- 🐿️ Acts as a personal facilitator between you and specialized agents
- 🗣️ Keeps local models, Claude Code, and Codex together in one shared room
- 🔌 Remains local-first and multi-provider

Squirl is not the default task executor. It preserves intent, notices gaps and conflicts,
keeps work oriented, and prepares handoffs for your approval.

---

## Features

### 🧠 Continuity and Memory
- **Semantic recall** from durable local conversation history
- **Cross-conversation continuity** for decisions, preferences, and unfinished work
- **Memory evaluation** for measuring retrieval and answer quality

### 🗣️ Shared Agent Room
- **Named participants** backed by local models, Claude Code, or Codex
- **Explicit routing and bounded handoffs** between participants
- **Continuous facilitation** at meaningful conflicts, blockers, decisions, and milestones

### Core Experience
- **Streaming responses** with live tokens/sec + latency feedback
- **Interrupt anytime** (`esc`) — no more waiting on slow generations
- **Context window tracking** — know exactly what you're burning
- **Shared chat history** — the web UI and TUI use the same durable local transcript
- **Prompt inspection** — see the identity, room state, project context, files, and recalled memory sent to the model

### 🔌 Multi-Provider by Design
- OpenAI, Anthropic (Claude)
- Local models via **Ollama**, **vLLM**, or any OpenAI-compatible API
- Seamless switching via model picker (`ctrl+p`)

### 🛠️ Supporting Tools
- File read/write
- Command execution
- Directory inspection

> Tools support context and explicit requests; they are not Squirl's primary identity.

### 🖥️ Web UI and TUI
- **Web app** with room roster, participant picker, settings, memory, context, health, and evaluation surfaces
- **Terminal UI** for a fast keyboard-driven workflow in the current workspace
- **Shared runtime state** across both interfaces, including history, configuration, agents, and memory
- Markdown rendering (code blocks, lists, etc.)
- Collapsible `<think>` blocks for reasoning models
- Paste collapsing for large inputs
- Streaming status, model metadata, and context-budget visibility

---

## What makes it different?

### 1. It's not trying to hide the model

Most tools abstract everything away.

**squirl surfaces reality:**
- tokens/sec
- context usage
- streaming behavior

You *see* how the model behaves.

---

### 2. It is a transparent personal AI runtime

Squirl combines:
- a **personal assistant** that preserves intent and continuity
- a **shared agent room** for specialized models and coding agents
- an **inspectable runtime** for prompts, retrieval, health, and evaluations

The web UI and TUI are two views onto the same conversations and runtime—not separate clients with separate memory.

---

### 3. Local-first, but not local-only

Use:
- local models for speed/privacy
- cloud models for quality

Switch instantly.

---

## Roadmap

The core chat, semantic memory, shared web/TUI runtime, agent room, prompt inspection,
and layered memory evaluations are implemented. Current priorities include:

- Persistent event delivery for background agents and multiple web clients
- Better asynchronous multi-agent coordination
- Query-extraction evaluation coverage
- Improved visibility into stale or failed memory indexing
- A decision on remote-agent transport scope

### 🧩 Modular Tool System
- Pluggable tools (like MCP-style servers)
- Bring your own:
  - database queries
  - APIs
  - internal services

### ⚡ Performance Modes
- Speculative decoding support
- Multi-model pipelines (draft + verify)
- Optimized for multi-GPU setups (vLLM)

### 🧪 Advanced Debugging
- Inspect tool calls
- Replay / fork conversations

---

## Getting Started

```bash
pnpm install
```

On first run, squirl walks you through:
- the optional name Squirl should use for you
- provider selection
- API key setup
- semantic-memory configuration

### Web UI

```bash
pnpm dev:web
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API runs on port `4174` and automatically restarts when backend code changes; Vite hot-reloads the web interface.

### Terminal UI

```bash
pnpm dev:cli
```

Both interfaces read and write the same configuration and conversation history under `~/.squirl/`.

Config lives at:
```
~/.squirl/config.json
```

Mouse wheel scrolling follows Vim/Neovim-style fixed line steps. To tune it:
```json
{
  "mouseScrollLines": 5
}
```

---

## TUI Keybindings

| Key | Action |
|-----|--------|
| Enter | Send message |
| Esc | Cancel streaming / clear input |
| Ctrl+C | Exit |
| Ctrl+P | Model picker |
| Ctrl+V | Toggle thinking blocks |
| Ctrl+R | Open room roster |
| Tab | Choose message recipient |
| Up/Down | Input history |
| Ctrl+A/E | Start/end of line |
| Ctrl+W | Delete word |
| Ctrl+U/K | Delete to start/end |

---

## Production Build

```bash
pnpm build
pnpm build:web
```

Run the compiled web app or TUI with:

```bash
pnpm start:web
pnpm start:cli
```

---

## Inspiration

- Claude Code (UX philosophy)
- Terminal tools like `lazydocker`, `htop`
- Shared-room collaboration tools
- The idea that AI should feel like a **primitive**, not a product

---

## License

Source-available under the [Elastic License 2.0](LICENSE). You may use, copy, modify, and redistribute squirl, but you may not:

- provide it to third parties as a hosted or managed service,
- circumvent license key functionality, or
- remove or obscure any licensing, copyright, or other notices.

See `LICENSE` for the full terms.
