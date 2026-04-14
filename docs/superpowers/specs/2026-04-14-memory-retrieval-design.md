# Multi-Stage Memory Retrieval Pipeline

## Problem

Squirl has a vector search pipeline (Chroma-backed, with embedders and a `/recall` command) but it's manual — the user must explicitly type `/recall <query>`. There's no automatic retrieval of relevant prior conversations when chatting. The LLM has no memory beyond the current session's conversation history.

## Goal

Automatically retrieve relevant past conversations and inject them into the LLM's context on every message. Use a multi-stage pipeline: first generate targeted search queries via a cheap LLM call, then search the vector store, then inject the results alongside the conversation before the main LLM response.

## Design

### Pipeline Overview

Three stages run in the orchestrator before the main LLM call, on every user message:

```
User sends message
        │
        ▼
┌──────────────────────┐
│ Stage 1: Meta-extract │  Cheap/configurable LLM
│ Generate 2-3 search   │  Sees full conversation
│ queries for retrieval  │  ~200 tokens output
└──────────┬───────────┘
           │ string[]
           ▼
┌──────────────────────┐
│ Stage 2: Retrieve     │  Embed each query
│ Multi-query vector    │  Merge + dedupe results
│ search, top K         │  Filter out current convo
└──────────┬───────────┘
           │ SearchResult[]
           ▼
┌──────────────────────┐
│ Stage 3: Inject       │  Format as system message
│ + Respond             │  Show inline in UI
│                       │  Send full context to LLM
└──────────────────────┘
```

### Stage 1: Meta-Extraction

**Input:**
- System prompt (~100 tokens) instructing the LLM to output search queries
- Full conversation history (same messages the main LLM would see)
- The new user message

**System prompt:**
```
You are a search query generator. Given the conversation below,
generate 2-3 short search queries that would find relevant prior
conversations from the user's history. Focus on topics, tools,
concepts, or patterns the user might have discussed before.
Output a JSON array of strings, nothing else.
```

**Output:** JSON array of 2-3 search query strings.

**Model:** Configured via `index.metaModel` and `index.metaProvider`. Falls back to the chat model if not set.

**Error handling:** If the meta call fails or returns unparseable output, skip retrieval entirely and proceed with the normal LLM call.

### Stage 2: Retrieval and Deduplication

1. Embed all 2-3 queries in a single batch call to the configured embedder (one network round-trip).
2. Run `vectorStore.query(embedding, k=8)` for each query embedding (higher per-query K so dedup still yields enough results).
3. Merge results: deduplicate by turn-pair ID, keep the best (lowest distance) score for duplicates.
4. Sort by score, take top K overall (configurable, default 10).
5. Filter out any turn-pairs whose content matches messages already in the current conversation history.

**Why per-query search:** Three focused queries hit different regions of the vector space. A single concatenated query averages into one point that may miss all topics. This is the standard multi-query RAG pattern.

**Cost:** 1 embedder call (batch of 2-3) + 2-3 vector store queries. Under 500ms total for local Chroma.

### Stage 3: Context Injection

Retrieved memories become a system message in the orchestrator's context assembly:

```
[system prompt]
[directory context]
[file context (@file references)]
[retrieved memories]              ← new
[conversation history]
```

**Memories system message format:**
```
The following are relevant excerpts from prior conversations that may
provide useful context:

---
[2026-04-10, source: squirl]
User: How do I set up Chroma with Docker?
Assistant: Run docker compose up -d with the provided docker-compose.yml...

---
[2026-04-09, source: chatgpt]
User: What embedding models work well for code search?
Assistant: nomic-embed-text is good for general purpose...
```

**Truncation priority:** Memories sit inside the truncation budget. If context is tight, truncation drops oldest conversation messages first (existing behavior), then memories. Memories are lower priority than the actual conversation.

### UI

**Status indicator:** The StatusBar shows `⠋ recalling (3)` during stages 1-2, using the existing `StatusEmitter` infrastructure.

**Inline display:** When memories are retrieved, a compact block renders in the message list before the assistant's streaming response:

```
╭ recalled 3 memories ─────────────────────╮
│ [Apr 10] Docker Compose setup for Chroma │
│ [Apr 09] Embedding models for code search│
│ [Apr 08] Vector store configuration      │
╰──────────────────────────────────────────╯
```

This is a `tool`-role message with `toolName: '/memory'` rendered dimmed. Each line shows date + a short topic snippet (first ~50 chars of userText).

## Config

New fields in the `index` section of `SquirlConfig`:

```ts
metaModel?: string;                          // e.g. "gpt-4o-mini", "haiku"
metaProvider?: 'openai' | 'anthropic' | 'local';
recallK?: number;                            // default 10
```

When `index.enabled` is true, the memory pipeline runs automatically on every message. No additional toggle.

## Files

### New

- `src/search/memory-pipeline.ts` — orchestrates the 3 stages. Single entry point:
  ```ts
  retrieveMemories(
    conversation: Message[],
    userMessage: string,
    embedder: Embedder,
    store: VectorStore,
    config: MemoryPipelineConfig,
  ): Promise<MemoryResult>
  ```
  Returns `{ results: SearchResult[], systemMessage: string, inlineDisplay: string }`.

- `src/search/meta-extract.ts` — the meta-extraction LLM call. Takes conversation + user message + model config, returns `string[]` (search queries). Handles JSON parsing and fallback.

- `src/search/memory-format.ts` — pure formatting functions:
  - `formatMemorySystemMessage(results: SearchResult[]): string` — the system message injected into LLM context
  - `formatMemoryInline(results: SearchResult[]): string` — the compact display for the UI

### Modified

- `src/orchestrator.ts` — call `retrieveMemories()` after building file context, before truncation. Insert memories system message into the context array. Add `onMemoryStart` and `onMemoryEnd(results)` to `ChatCallbacks`.

- `src/app.tsx` — handle `onMemoryStart`/`onMemoryEnd` callbacks: trigger status indicator, render inline memory block as a tool message when results arrive.

- `src/config.ts` — add `metaModel`, `metaProvider`, `recallK` fields to the `index` config type.

- `src/commands/registry.ts` — update `/recall` help text to note that auto-retrieval is active when indexing is enabled.

### Reused

- `src/search/recall.ts` — `recall()` function used for the vector search step
- `src/search/types.ts` — `SearchResult`, `TurnPair`, `Embedder`, `VectorStore`
- `src/search/embedders/index.ts` — `createEmbedder()` for embedding search queries
- `src/search/status.ts` — `StatusEmitter` for the status indicator
- `src/api.ts` — existing OpenAI/Anthropic streaming clients reused for the meta-extraction call
- `src/components/IndexStatus.tsx` — already wired into StatusBar

## Error Handling

Every stage is wrapped in try/catch. If any stage fails:
- Log the error (stderr, not in UI)
- Skip retrieval
- Proceed with the normal LLM call as if memory was disabled

Memory is an enhancement, never a gate.

## Testing

- **Unit: `meta-extract.ts`** — mock the LLM call, verify it produces a string array, verify fallback on invalid JSON, verify fallback on API error
- **Unit: `memory-pipeline.ts`** — mock embedder/store/meta-extract, verify end-to-end flow: queries generated → embedded → searched → deduped → top K selected → conversation-duplicates filtered
- **Unit: `memory-format.ts`** — verify system message format and inline display format against snapshot
- **Integration:** enable in config, start Chroma, chat several turns, observe status indicator + inline memories + verify memories appear in LLM context (check via /system command)
