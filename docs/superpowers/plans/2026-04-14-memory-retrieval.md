# Memory Retrieval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically retrieve relevant past conversations via a multi-stage pipeline (meta-extraction → vector search → context injection) on every user message.

**Architecture:** A `MemoryPipeline` class orchestrates three stages: (1) a cheap LLM call generates 2-3 search queries from the full conversation, (2) those queries are embedded and searched against the vector store with dedup, (3) results are formatted as a system message for the LLM and an inline display for the UI. The pipeline is called from the orchestrator before the main LLM call.

**Tech Stack:** TypeScript ESM (.js import extensions), vitest, existing OpenAI/Anthropic SDKs, existing embedder + vector store infrastructure.

**Spec:** `docs/superpowers/specs/2026-04-14-memory-retrieval-design.md`

---

### Task 0: Config schema update

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add memory pipeline config fields**

In `src/config.ts`, add three fields to the `index` type inside `SquirlConfig`. The current `index` type ends with `ollamaUrl?: string;`. After that line, add:

```ts
    metaModel?: string;
    metaProvider?: 'openai' | 'anthropic' | 'local';
    recallK?: number;
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add memory pipeline config fields"
```

---

### Task 1: Meta-extraction module

**Files:**
- Create: `src/search/meta-extract.ts`
- Create: `src/search/meta-extract.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/search/meta-extract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractSearchQueries } from './meta-extract.js';
import type { Message } from '../types.js';

const user = (content: string): Message => ({ id: 'u1', role: 'user', content });
const asst = (content: string): Message => ({ id: 'a1', role: 'assistant', content });

describe('extractSearchQueries', () => {
  it('calls the LLM and parses JSON array of queries', async () => {
    const mockComplete = vi.fn().mockResolvedValue('["docker setup", "chroma config"]');

    const queries = await extractSearchQueries(
      [user('How do I set up Chroma?'), asst('Use docker compose...')],
      'Can I change the port?',
      { complete: mockComplete },
    );

    expect(queries).toEqual(['docker setup', 'chroma config']);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toContain('search quer');
  });

  it('returns empty array if LLM returns invalid JSON', async () => {
    const mockComplete = vi.fn().mockResolvedValue('not json at all');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('returns empty array if LLM call throws', async () => {
    const mockComplete = vi.fn().mockRejectedValue(new Error('network error'));
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual([]);
  });

  it('filters out non-string entries from the array', async () => {
    const mockComplete = vi.fn().mockResolvedValue('["valid", 123, null, "also valid"]');
    const queries = await extractSearchQueries([user('hello')], 'hi', { complete: mockComplete });
    expect(queries).toEqual(['valid', 'also valid']);
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`pnpm test src/search/meta-extract.test.ts`)

- [ ] **Step 3: Implement**

```ts
// src/search/meta-extract.ts
import type { Message } from '../types.js';

const SYSTEM_PROMPT = `You are a search query generator. Given the conversation below, generate 2-3 short search queries that would find relevant prior conversations from the user's history. Focus on topics, tools, concepts, or patterns the user might have discussed before. Output a JSON array of strings, nothing else.`;

export interface MetaLLM {
  complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<string>;
}

export async function extractSearchQueries(
  conversation: Message[],
  userMessage: string,
  llm: MetaLLM,
): Promise<string[]> {
  try {
    const messages = conversation
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    messages.push({ role: 'user', content: userMessage });

    const response = await llm.complete({ systemPrompt: SYSTEM_PROMPT, messages });

    const parsed = JSON.parse(response);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === 'string');
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test → 4 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/search/meta-extract.ts src/search/meta-extract.test.ts
git commit -m "feat(search): meta-extraction LLM call for search queries"
```

---

### Task 2: Memory formatting module

**Files:**
- Create: `src/search/memory-format.ts`
- Create: `src/search/memory-format.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/search/memory-format.test.ts
import { describe, it, expect } from 'vitest';
import { formatMemorySystemMessage, formatMemoryInline } from './memory-format.js';
import type { SearchResult } from './types.js';

function sr(id: string, userText: string, assistantText: string, source: string, timestamp: string, score: number): SearchResult {
  return { id, score, turnPair: { id, source, conversationId: 'c1', timestamp, userText, assistantText } };
}

describe('formatMemorySystemMessage', () => {
  it('formats results into a system message with header', () => {
    const results = [
      sr('r1', 'How to set up Docker?', 'Use docker compose up -d', 'squirl', '2026-04-10T12:00:00Z', 0.1),
      sr('r2', 'Best embedding model?', 'nomic-embed-text works well', 'chatgpt', '2026-04-09T12:00:00Z', 0.2),
    ];
    const msg = formatMemorySystemMessage(results);
    expect(msg).toContain('relevant excerpts from prior conversations');
    expect(msg).toContain('2026-04-10');
    expect(msg).toContain('squirl');
    expect(msg).toContain('How to set up Docker?');
    expect(msg).toContain('Use docker compose up -d');
    expect(msg).toContain('chatgpt');
  });

  it('returns empty string for empty results', () => {
    expect(formatMemorySystemMessage([])).toBe('');
  });
});

describe('formatMemoryInline', () => {
  it('formats compact one-line-per-memory display', () => {
    const results = [
      sr('r1', 'How to set up Docker?', 'answer', 'squirl', '2026-04-10T12:00:00Z', 0.1),
      sr('r2', 'Best embedding model?', 'answer', 'chatgpt', '2026-04-09T12:00:00Z', 0.2),
    ];
    const display = formatMemoryInline(results);
    expect(display).toContain('recalled 2 memories');
    expect(display).toContain('Apr 10');
    expect(display).toContain('How to set up Docker?');
  });

  it('returns empty string for empty results', () => {
    expect(formatMemoryInline([])).toBe('');
  });

  it('truncates long user text', () => {
    const results = [sr('r1', 'A'.repeat(100), 'answer', 'squirl', '2026-04-10T12:00:00Z', 0.1)];
    const display = formatMemoryInline(results);
    expect(display).toContain('...');
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`pnpm test src/search/memory-format.test.ts`)

- [ ] **Step 3: Implement**

```ts
// src/search/memory-format.ts
import type { SearchResult } from './types.js';

export function formatMemorySystemMessage(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const header = 'The following are relevant excerpts from prior conversations that may provide useful context:\n';
  const entries = results.map((r) => {
    const date = r.turnPair.timestamp.slice(0, 10);
    return `---\n[${date}, source: ${r.turnPair.source}]\nUser: ${r.turnPair.userText}\nAssistant: ${r.turnPair.assistantText}`;
  });

  return header + '\n' + entries.join('\n\n');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(timestamp: string): string {
  const d = new Date(timestamp);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function formatMemoryInline(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const lines = results.map((r) => {
    const date = shortDate(r.turnPair.timestamp);
    const snippet = r.turnPair.userText.length > 50
      ? r.turnPair.userText.slice(0, 50) + '...'
      : r.turnPair.userText;
    return `  [${date}] ${snippet}`;
  });

  return `recalled ${results.length} memories\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run test → 5 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/search/memory-format.ts src/search/memory-format.test.ts
git commit -m "feat(search): memory formatting for system message and inline display"
```

---

### Task 3: Memory pipeline

**Files:**
- Create: `src/search/memory-pipeline.ts`
- Create: `src/search/memory-pipeline.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/search/memory-pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MemoryPipeline } from './memory-pipeline.js';
import type { Embedder, VectorStore, TurnPair, SearchResult } from './types.js';
import type { MetaLLM } from './meta-extract.js';
import type { Message } from '../types.js';

const tp = (id: string, userText: string): TurnPair => ({
  id, source: 'squirl', conversationId: 'c1', timestamp: '2026-04-10T12:00:00Z',
  userText, assistantText: 'answer for ' + id,
});

const sr = (id: string, userText: string, score: number): SearchResult => ({
  id, score, turnPair: tp(id, userText),
});

function mockLLM(): MetaLLM {
  return { complete: vi.fn().mockResolvedValue('["query1", "query2"]') };
}

function mockEmbedder(): Embedder & { embed: ReturnType<typeof vi.fn> } {
  return {
    name: 'test', dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}

function mockStore(results: SearchResult[][]): VectorStore & { query: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    query: vi.fn(async () => results[callIndex++] ?? []),
    upsert: vi.fn(), has: vi.fn(), close: vi.fn(),
  };
}

describe('MemoryPipeline', () => {
  it('runs full pipeline: meta-extract → embed → search → format', async () => {
    const llm = mockLLM();
    const embedder = mockEmbedder();
    const store = mockStore([
      [sr('r1', 'docker setup', 0.1), sr('r2', 'chroma config', 0.3)],
      [sr('r2', 'chroma config', 0.2), sr('r3', 'embeddings', 0.4)],
    ]);

    const pipeline = new MemoryPipeline(llm, embedder, store, { recallK: 10 });
    const conversation: Message[] = [{ id: 'u1', role: 'user', content: 'hello' }];
    const result = await pipeline.retrieve(conversation, 'set up chroma');

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith(['query1', 'query2']);
    expect(store.query).toHaveBeenCalledTimes(2);
    // r2 deduped: appears in both, best score kept (0.2)
    expect(result.results).toHaveLength(3);
    expect(result.results.find((r) => r.id === 'r2')!.score).toBe(0.2);
    expect(result.systemMessage).toContain('relevant excerpts');
    expect(result.inlineDisplay).toContain('recalled 3 memories');
  });

  it('deduplicates and keeps best score', async () => {
    const store = mockStore([[sr('r1', 'q', 0.5)], [sr('r1', 'q', 0.1)]]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 10 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.score).toBe(0.1);
  });

  it('respects recallK limit', async () => {
    const many = Array.from({ length: 10 }, (_, i) => sr(`r${i}`, `q${i}`, i * 0.1));
    const store = mockStore([many, []]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 3 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toHaveLength(3);
  });

  it('filters out turn-pairs already in conversation', async () => {
    const store = mockStore([[sr('r1', 'hello', 0.1)], []]);
    const pipeline = new MemoryPipeline(mockLLM(), mockEmbedder(), store, { recallK: 10 });
    const conversation: Message[] = [{ id: 'x', role: 'user', content: 'hello' }];
    const result = await pipeline.retrieve(conversation, 'test');
    expect(result.results).toHaveLength(0);
  });

  it('returns empty result if meta-extraction fails', async () => {
    const llm: MetaLLM = { complete: vi.fn().mockRejectedValue(new Error('fail')) };
    const pipeline = new MemoryPipeline(llm, mockEmbedder(), mockStore([]), { recallK: 10 });
    const result = await pipeline.retrieve([], 'test');
    expect(result.results).toEqual([]);
    expect(result.systemMessage).toBe('');
    expect(result.inlineDisplay).toBe('');
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`pnpm test src/search/memory-pipeline.test.ts`)

- [ ] **Step 3: Implement**

```ts
// src/search/memory-pipeline.ts
import type { Message } from '../types.js';
import type { Embedder, VectorStore, SearchResult } from './types.js';
import { extractSearchQueries } from './meta-extract.js';
import type { MetaLLM } from './meta-extract.js';
import { formatMemorySystemMessage, formatMemoryInline } from './memory-format.js';

export interface MemoryPipelineConfig {
  recallK: number;
}

export interface MemoryResult {
  results: SearchResult[];
  systemMessage: string;
  inlineDisplay: string;
}

const PER_QUERY_K = 8;

export class MemoryPipeline {
  constructor(
    private readonly llm: MetaLLM,
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly config: MemoryPipelineConfig,
  ) {}

  async retrieve(conversation: Message[], userMessage: string): Promise<MemoryResult> {
    const empty: MemoryResult = { results: [], systemMessage: '', inlineDisplay: '' };

    const queries = await extractSearchQueries(conversation, userMessage, this.llm);
    if (queries.length === 0) return empty;

    const embeddings = await this.embedder.embed(queries);

    const allResults: SearchResult[] = [];
    for (const embedding of embeddings) {
      const results = await this.store.query(embedding, PER_QUERY_K);
      allResults.push(...results);
    }

    const deduped = new Map<string, SearchResult>();
    for (const r of allResults) {
      const existing = deduped.get(r.id);
      if (!existing || r.score < existing.score) {
        deduped.set(r.id, r);
      }
    }

    const conversationTexts = new Set(
      conversation.filter((m) => m.role === 'user').map((m) => m.content),
    );
    const filtered = [...deduped.values()].filter(
      (r) => !conversationTexts.has(r.turnPair.userText),
    );

    filtered.sort((a, b) => a.score - b.score);
    const topK = filtered.slice(0, this.config.recallK);

    if (topK.length === 0) return empty;

    return {
      results: topK,
      systemMessage: formatMemorySystemMessage(topK),
      inlineDisplay: formatMemoryInline(topK),
    };
  }
}
```

- [ ] **Step 4: Run test → 5 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/search/memory-pipeline.ts src/search/memory-pipeline.test.ts
git commit -m "feat(search): memory retrieval pipeline with multi-query dedup"
```

---

### Task 4: MetaLLM adapters for OpenAI and Anthropic

**Files:**
- Create: `src/search/meta-llm.ts`
- Create: `src/search/meta-llm.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/search/meta-llm.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAIMetaLLM, AnthropicMetaLLM } from './meta-llm.js';

describe('OpenAIMetaLLM', () => {
  it('calls OpenAI chat completions and returns content', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["q1", "q2"]' } }],
    });
    const llm = new OpenAIMetaLLM({ model: 'gpt-4o-mini', createFn: mockCreate });

    const result = await llm.complete({
      systemPrompt: 'generate queries',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toBe('["q1", "q2"]');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
  });
});

describe('AnthropicMetaLLM', () => {
  it('calls Anthropic messages and returns text', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '["q1"]' }],
    });
    const llm = new AnthropicMetaLLM({ model: 'claude-haiku-4-5-20251001', createFn: mockCreate });

    const result = await llm.complete({
      systemPrompt: 'generate queries',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toBe('["q1"]');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
      system: 'generate queries',
    }));
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`pnpm test src/search/meta-llm.test.ts`)

- [ ] **Step 3: Implement**

```ts
// src/search/meta-llm.ts
import type { MetaLLM } from './meta-extract.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

type OpenAICreateFn = (params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
}) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;

interface OpenAIMetaLLMOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  createFn?: OpenAICreateFn;
}

export class OpenAIMetaLLM implements MetaLLM {
  private readonly model: string;
  private readonly create: OpenAICreateFn;

  constructor(opts: OpenAIMetaLLMOptions) {
    this.model = opts.model;
    if (opts.createFn) {
      this.create = opts.createFn;
    } else {
      const client = new OpenAI({
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? '',
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      this.create = (params) => client.chat.completions.create(params as any) as any;
    }
  }

  async complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<string> {
    const response = await this.create({
      model: this.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        ...params.messages,
      ],
      max_tokens: 300,
    });
    return response.choices[0]?.message?.content ?? '';
  }
}

type AnthropicCreateFn = (params: {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  max_tokens: number;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface AnthropicMetaLLMOptions {
  model: string;
  apiKey?: string;
  createFn?: AnthropicCreateFn;
}

export class AnthropicMetaLLM implements MetaLLM {
  private readonly model: string;
  private readonly create: AnthropicCreateFn;

  constructor(opts: AnthropicMetaLLMOptions) {
    this.model = opts.model;
    if (opts.createFn) {
      this.create = opts.createFn;
    } else {
      const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '' });
      this.create = (params) => client.messages.create(params as any) as any;
    }
  }

  async complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<string> {
    const response = await this.create({
      model: this.model,
      system: params.systemPrompt,
      messages: params.messages,
      max_tokens: 300,
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }
}
```

- [ ] **Step 4: Run test → 2 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/search/meta-llm.ts src/search/meta-llm.test.ts
git commit -m "feat(search): MetaLLM adapters for OpenAI and Anthropic"
```

---

### Task 5: Wire pipeline into orchestrator

**Files:**
- Modify: `src/orchestrator.ts`

- [ ] **Step 1: Add import**

Add at top of `src/orchestrator.ts`:
```ts
import type { MemoryPipeline } from './search/memory-pipeline.js';
```

- [ ] **Step 2: Add memory callbacks to ChatCallbacks**

Add after `onToolEnd` in the `ChatCallbacks` interface (line 19):
```ts
  onMemoryStart?: () => void;
  onMemoryEnd?: (inlineDisplay: string) => void;
```

- [ ] **Step 3: Add field and setter to Orchestrator class**

Add field after `private workingDir: string;` (line 29):
```ts
  private memoryPipeline: MemoryPipeline | null = null;
```

Add setter after constructor:
```ts
  setMemoryPipeline(pipeline: MemoryPipeline | null): void {
    this.memoryPipeline = pipeline;
  }
```

- [ ] **Step 4: Add memory retrieval in chat() method**

In `chat()`, after building `fileContextMessage` (after current line 92: `? { role: 'system', content: ... } : null;`) and before the comment `// 7. Convert conversation history` (current line 94), insert:

```ts
    // 6b. Memory retrieval
    let memoryMessage: ChatCompletionMessageParam | null = null;
    if (this.memoryPipeline) {
      callbacks.onMemoryStart?.();
      try {
        const memResult = await this.memoryPipeline.retrieve(conversationHistory, cleanedInput);
        if (memResult.systemMessage) {
          memoryMessage = { role: 'system', content: memResult.systemMessage };
        }
        callbacks.onMemoryEnd?.(memResult.inlineDisplay);
      } catch {
        callbacks.onMemoryEnd?.('');
      }
    }
```

- [ ] **Step 5: Modify context assembly to include memories**

Replace the current truncation block (lines 98-104):
```ts
    const { messages: truncatedMessages } = truncateToFit(
      systemMessages,
      fileContextMessage,
      conversationApiMessages,
      config.contextWindow,
    );
```

With:
```ts
    const allSystemMessages = [...systemMessages];
    if (fileContextMessage) allSystemMessages.push(fileContextMessage);
    if (memoryMessage) allSystemMessages.push(memoryMessage);

    const { messages: truncatedMessages } = truncateToFit(
      allSystemMessages,
      null,
      conversationApiMessages,
      config.contextWindow,
    );
```

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: wire memory pipeline into orchestrator"
```

---

### Task 6: Wire pipeline into app.tsx

**Files:**
- Modify: `src/app.tsx`

- [ ] **Step 1: Add imports**

Add near top with other search imports:
```ts
import { MemoryPipeline } from './search/memory-pipeline.js';
import { OpenAIMetaLLM, AnthropicMetaLLM } from './search/meta-llm.js';
import type { MetaLLM } from './search/meta-extract.js';
```

- [ ] **Step 2: Create MemoryPipeline in init effect**

In the existing `useEffect` that initializes the index pipeline (the one checking `config?.index?.enabled`), after the line `ingestQueueRef.current = queue;`, add:

```ts
    const metaProvider = config.index!.metaProvider ?? config.defaultProvider ?? 'openai';
    const metaModel = config.index!.metaModel ?? 'gpt-4o-mini';
    let metaLLM: MetaLLM;
    if (metaProvider === 'anthropic') {
      metaLLM = new AnthropicMetaLLM({ model: metaModel });
    } else {
      metaLLM = new OpenAIMetaLLM({
        model: metaModel,
        ...(metaProvider === 'local' ? { baseUrl: config.localBaseUrl } : {}),
      });
    }

    const memoryPipeline = new MemoryPipeline(metaLLM, embedder, store, {
      recallK: config.index!.recallK ?? 10,
    });
    orchestratorRef.current.setMemoryPipeline(memoryPipeline);
```

- [ ] **Step 3: Add memory callbacks in handleSubmit**

In the callbacks object passed to `orchestratorRef.current.chat()`, add after `onToolEnd`:

```ts
        onMemoryStart: () => {
          setToolStatus('Recalling...');
        },
        onMemoryEnd: (inlineDisplay) => {
          setToolStatus('');
          if (inlineDisplay) {
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'tool' as const,
              toolCallId: 'memory',
              toolName: '/memory',
              content: inlineDisplay,
            }]);
          }
        },
```

- [ ] **Step 4: Clean up on unmount**

In the cleanup return of the init effect, add:
```ts
    orchestratorRef.current.setMemoryPipeline(null);
```

- [ ] **Step 5: Commit**

```bash
git add src/app.tsx
git commit -m "feat: wire memory pipeline into app with inline display"
```

---

### Task 7: Full test suite + integration verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```
Expected: All tests pass.

- [ ] **Step 2: TypeScript compilation check**

```bash
pnpm build
```
Expected: No type errors.

- [ ] **Step 3: Manual integration test**

1. Ensure Chroma running: `docker compose up -d`
2. Config: `index.enabled: true`, `metaModel: "gpt-4o-mini"`, `metaProvider: "openai"`
3. `pnpm dev`
4. Chat several turns to build history
5. Ask a question related to earlier turns
6. Observe: "Recalling..." in status bar → inline memory block → assistant response with context

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "fix: integration fixups for memory pipeline"
```

---

## Reference: Key Existing Files

| File | What to know |
|---|---|
| `src/orchestrator.ts:13-20` | `ChatCallbacks` interface — add `onMemoryStart`/`onMemoryEnd` here |
| `src/orchestrator.ts:88-104` | Context assembly + truncation — insert memory message here |
| `src/app.tsx` init effect | Index pipeline init — create MemoryPipeline here |
| `src/app.tsx:285-368` | `handleSubmit` — add memory callbacks here |
| `src/config.ts:14-23` | `SquirlConfig.index` — add 3 new fields |
| `src/search/types.ts` | `SearchResult`, `TurnPair`, `Embedder`, `VectorStore` |
| `src/search/recall.ts` | Existing `recall()` — pipeline replaces this for auto-retrieval |
| `src/context/truncation.ts` | `truncateToFit()` — manages context budget |
