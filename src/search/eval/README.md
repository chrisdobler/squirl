# Memory-system evaluation harness

Measure whether a change to the memory/retrieval system (`src/search/`) improves or regresses
retrieval quality, instead of guessing. Driven by a hand-curated golden set; runs deterministically
(frozen mode) or against real services (live mode).

## TL;DR

```bash
# one-time (or after changing the embedder / chunking): build the frozen embedding fixture
npm run eval:refresh                       # production embedder: BAAI/bge-large-en-v1.5 on gpu1

# run the deterministic retrieval eval and save a baseline
npm run eval -- --label baseline --out results/baseline.json

# ...make a change to ranking / recallK / etc, then run again
npm run eval -- --label change --recallK 5 --out results/change.json

# did it help or hurt?
npm run eval:compare -- results/baseline.json results/change.json
```

`compare` prints a per-metric delta table with verdicts and flags any per-case recall regressions,
so a mean improvement can't hide a broken case.

## Layers

Each layer isolates a different part of the pipeline:

| Layer | Command | Runs | Isolates |
|---|---|---|---|
| **1** retrieval | `npm run eval` | gold queries → embed → store.query → rank | embedder, chunking, ranking/recallK |
| **2** end-to-end | `npm run eval:e2e` | the real `MemoryPipeline.retrieve()` | composition (query-extraction + retrieval) |
| **3** answer quality | `npm run eval:judge` | answer **with vs without** memory → LLM judge scores correctness | the pipeline's downstream value |
| 0 query-extraction | _(not built)_ | `extractSearchQueries()` | the meta-LLM prompt |

The gap between Layer 1 (gold queries) and Layer 2 (extracted queries) tells you how much query
extraction is costing you.

### Layer 3 — answer correctness

Layer 3 is the one that measures whether memory makes the **answer** right, not just whether the right
memory was fetched. For each case with `expectedAnswerNotes`, it generates two answers — one with the
retrieved memory injected, one without — and an LLM judge scores which is more correct (position is
randomized per case to cancel bias). It reports a **memory win-rate** and **mean correctness** (1–5)
with vs without memory.

Retrieval is deterministic (frozen), but the answer + judge calls are **live**, so this needs an
answer model and a judge reachable. The judge defaults to your configured meta provider
(`config.index.metaProvider`/`metaModel`); override any of it:

```bash
npm run eval:judge -- --answer-provider openai --answer-model gpt-4o-mini \
                      --judge-provider openai --judge-model gpt-4o-mini --label judge-openai
```

## Frozen vs live

- **Frozen** (default): corpus + gold-query vectors are loaded from a committed fixture
  (`fixtures/embeddings/<embedder>__<chunkHash>.json`) and served by an in-memory cosine-distance
  store. No network, deterministic, CI-friendly. This is the mode for iterating on ranking, recallK,
  filtering, and query extraction.
- **Live** (`--mode live`): embeds the corpus with the real embedder and uses a real meta-LLM. This
  is the mode for evaluating **embedder swaps** and **chunking changes** (which change what gets
  embedded). Requires the embedder/meta provider to be reachable.

Changing the embedder or chunking selects a different fixture filename. If the fixture for your
current `(embedder, chunk)` pair is missing, frozen mode errors and tells you to run `refresh` — a
stale fixture can never be used silently.

### Embedders

The default npm scripts use squirl's production embedder, `BAAI/bge-large-en-v1.5` (1024-dim) on gpu1
(`http://gpu1.skyhouse.dobsys.com:8000/v1`), so the frozen baseline reflects the real system. Frozen
runs only need `--embedder local --embedder-model BAAI/bge-large-en-v1.5` (no URL / no network);
`refresh` and `--mode live` also need `--embedder-url`.

A second committed fixture uses OpenAI `text-embedding-3-small` (1536-dim), so you can A/B the two
embedders entirely in frozen mode:

```bash
# build the OpenAI fixture once (needs OPENAI_API_KEY), then run + compare against the bge baseline
tsx src/search/eval/runner.ts refresh --embedder openai
tsx src/search/eval/runner.ts run --mode frozen --layer 1 --embedder openai --label openai --out results/openai.json
npm run eval -- --label bge --out results/bge.json
npm run eval:compare -- results/openai.json results/bge.json
```

## The golden set

- `fixtures/corpus.jsonl` — the "memories" in the store, one `TurnPair` per line.
- `fixtures/cases.jsonl` — one `EvalCase` per line:
  - `conversation` + `userMessage`: the retrieval trigger.
  - `qrels`: `{ corpusId: grade }` where `2` = highly relevant, `1` = relevant, absent = irrelevant.
  - `goldQueries`: reference search queries that feed Layer 1 deterministically.
  - `expectedAnswerNotes`: facts a correct answer must contain (for the Phase 2 judge).

Add a case by appending a line to `cases.jsonl` (and any new corpus entries to `corpus.jsonl`), then
re-run `eval:refresh` so the new gold queries get embedded into the fixture.

The starter set is deliberately clean — most cases retrieve perfectly with good embeddings, which
makes it a sensitive **regression** detector. To measure **improvements**, add harder cases
(closer distractors, more paraphrase, multi-hop).

## Metrics

`recall@k`, `precision@k`, `hit-rate@k`, `nDCG@k` (graded), and `MRR`, averaged over cases. Cases
with no relevant docs are excluded from recall/nDCG/MRR means. Default cutoffs: `1,3,5,8,10`
(override with `--ks`).

## In-app dashboard (web/Electron)

The numbers are easier to read as a **trend**. The web/Electron UI has an **eval** panel that charts
metrics over runs:

- Every run — CLI *or* in-app — appends a compact summary to `~/.squirl/eval/history.jsonl`. That log
  is the shared timeline both feed.
- The panel draws a multi-line trend (`recall@5/10`, `nDCG@10`, `MRR`, and for Layer 3
  `memory win-rate` + `answer correctness`), a runs table, and a **Run** button that streams progress
  and drops a new point.
- Runs are grouped into **series** (`layer:mode:embedder:chunkHash`) so an OpenAI run and a bge run
  are never connected on the same line. A selector picks the series; it defaults to the most recent.

Open it with `npm run dev:web` → the **eval** tab in the left rail.

### Automatic self-monitoring

Toggle **auto-monitor** in the panel (or set `config.eval.monitor`) and squirl runs an eval on a timer
so it tracks its own memory quality unattended:

```json
"eval": { "monitor": { "enabled": true, "intervalHours": 24, "layer": 1, "mode": "frozen" } }
```

It runs once on startup if the last run is stale, then every `intervalHours`. Default **off**; default
target is Layer 1 frozen (cheap, offline). Each run appends a `monitor`-labeled point to the timeline.

## Notes / caveats

- The frozen store uses **cosine distance** (`1 - cosine`). Real Chroma defaults to L2; both treat
  lower scores as more similar. Frozen and live absolute scores may differ slightly, but rankings are
  the comparable signal.
- `results/` is gitignored; `fixtures/` (golden set + embedding fixtures) is committed. The shared
  trend log lives at `~/.squirl/eval/history.jsonl`.
- The eval fixtures (`fixtures/*.jsonl`) live under `src/`; the in-app **Run** button reads them via
  `tsx` in `dev:web`. A packaged production build would need them copied into `dist/` — not yet wired.
- Layer 0 (query-extraction quality) is the only layer not built.
