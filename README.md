
> **Heavy work in progress.** Until this notice is removed, discretion is advised — do not rely on this plugin for vaults you cannot afford to lose.

# Vault Ease of Maintenance

An LLM-driven assistant that keeps an Obsidian vault easy to maintain. It builds a GraphRAG-style search index of the vault's notes, then uses agents to clean notes, sort the inbox, and answer questions. Everything runs inside Obsidian, you do not need Python, a server, or Docker.

## Plans & Goals

- **Goal** — keep growing vaults maintainable: agents tidy messy notes, triage the inbox, and answer questions with cited sources. Nothing changes without your review.
- **Retrieval** — a GraphRAG-style index: semantic embeddings, an entity/relationship graph, and LLM-written community reports. It is a pragmatic, in-process take on GraphRAG — embeddings stay the primary retrieval signal, and there is no external graph database or clustering service.
- **Providers** — any OpenAI-compatible API, hosted or fully local. Bring your own key. I will expand to Claude's API in the future.
- **Roadmap** — the retrieval layer (hybrid search, community reports, global mode, semantic edges) is complete; incremental index builds are wired. Next: agentic capabilities across clean, sort, and build.

## Current Features

- **Build the index** — Builds the GraphRAG-style index: notes are split into sections, each section is embedded, entities and relationships are extracted into a graph, and communities get LLM-written reports. Rebuilds are incremental.
- **Clean current note** — The cleanup agent proposes edits for the note you have open. Review the diff in the review pane, then accept or reject.
- **Sort inbox** — The triage agent suggests where each inbox note belongs. Nothing moves without your approval.
- **Chat with your vault** — Ask a question; the agent answers from the index with cited sources. Models that support tool calls run agentically; others automatically get a deterministic retrieval fallback.

## How Retrieval Works (GraphRAG-style)

The index is a **hybrid of embeddings and a graph**, tuned to run entirely inside Obsidian:

- **Embeddings** — every note section is embedded; semantic search is a cosine scan over stored vectors.
- **Entity graph** — wikilinks, backlinks, and LLM-extracted semantic relationships form edges that chat search traverses alongside the embeddings.
- **Community reports** — notes are grouped into communities; the LLM writes a summary per community, and overview-style questions ("what is this vault about?") are answered from those reports.

It is **not** canonical Microsoft GraphRAG — there is no Leiden clustering and no external graph store. It is a GraphRAG-style hybrid that keeps embeddings as the primary retrieval signal while adding graph traversal and a global-report mode.

## Providers

The indexer and agents speak to any **OpenAI-compatible API**:

- **Hosted** — OpenAI, OpenRouter, or any compatible cloud endpoint.
- **Local** — OMLX, Ollama, LM Studio, vLLM, or any local OpenAI-compatible server.

Bring your own key: set it in the Settings tab, in `config.yaml`, or via an environment variable (`OMLX_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`). Model choice is free — small local models work too, and chat automatically falls back to deterministic retrieval when a model cannot emit tool calls.

## Quick Start

### 1. Install the plugin

Install from the Obsidian community store:

**https://community.obsidian.md/plugins/ease-of-maintenance**

Store installs work out of the box — the SQLite engine (sql.js, SQLite compiled to WebAssembly) is embedded inside `main.js`, so there is no native module, no `node_modules` in the plugin folder, and no extra asset to ship.

### 2. Set the API key

The indexer and agents call an OpenAI-compatible API. Use OpenAI, OpenRouter, or a local server such as OMLX.

Set the key in one of these places:

1. Plugin Settings → API Key.
2. `api.api_key` in `config.yaml` (repo-local, plugin dir).
3. An environment variable: `OMLX_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

The plugin checks these sources in this order.

### 3. Configure the plugin

The **Settings tab is the main configuration** and always wins. Resolution order:

```
code defaults ← <pluginDir>/config.yaml ← Settings tab (MAIN)
```

- **Plugin-store users:** configure the Settings tab only (they have no `config.yaml`).
- **Repo users / local dev:** copy `config.example.yaml` → `config.yaml` in the plugin folder.
- There is **no vault-level config file** by design — vaults may live in shared/company databases where API keys and parameters must not be stored. Config lives only in the Settings tab and the repo's `config.yaml`. See `config.example.yaml` for all options.

### 4. Build the index

Run the command **Build graphrag index**. The plugin scans the vault, splits notes into header sections, extracts entities and relationships, builds the graph, writes community reports, and creates embeddings. It stores the index at `{vault}/.note-maintainer/index.db`.

If no `_manifest.md` exists, the plugin derives one from the index. Review it before you run sort.

### 5. Use the agents

- **Clean current note** — clean the note you have open. The plugin proposes edits. Review the diff in the modal, then accept or reject.
- **Sort inbox** — triage the inbox. The plugin returns placement decisions. It does not move files without your approval.
- **Chat with your vault** — ask a question. The plugin answers from the index with cited sources.

### Manual install (repo users / local dev)

1. Run `npm run build` in the repo root. This writes `main.js` (with the
   sql.js WASM engine embedded inside it) and `sql-wasm.wasm` (kept as a
   convenience asset for local installs; not required).
2. Create the folder `<vault>/.obsidian/plugins/obsidian-vault-ease-of-maintenance/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
   `sql-wasm.wasm` is optional — the engine is embedded in `main.js`, so the
   standard three-file set (exactly what the community store installs)
   works.
   Easiest: run `./build-plugin.sh <vault-path>` (copies all four files).
4. Enable the plugin in Obsidian: Settings → Community Plugins.

On the first run after upgrading from a version that used the native
`better-sqlite3` engine, the plugin retires the old index to
`.note-maintainer/legacy/` and rebuilds it once (the index is derived data;
Obsidian notifies you).

## Commands

| Command | Purpose |
|---|---|
| Build graphrag index | Full index rebuild from scratch. |
| Clean current note | Run the cleanup agent on the open note. |
| Sort inbox | Run the triage agent on the inbox. |
| Chat with your vault | Ask a question about the vault. The chat agent can ask clarifying questions inline (the `clarify` tool) and, for manifest-review requests, propose a manifest update with a diff you accept or reject. |
| Understand vault (read it like a book) | Run the vault-comprehension pipeline: skim the vault like flipping through pages, form and score hypotheses in a persistent ledger, verify them against the index, ask for clarification only on deterministic triggers, and write a one-page summary card (`.note-maintainer/vault-summary.md`) that later sessions load instantly. |

## Plugin Settings

| Setting | Purpose |
|---|---|
| Review container | Where clean/sort reviews and chat open: a docked sidebar pane or a centered modal overlay. |
| API Key | Key for the OpenAI-compatible API. Optional when you use an env var. |
| API Base URL | Base URL of the API. |
| Reasoning model | Model for clean, sort, and chat. |
| Embedding Model | Model for embeddings. |
| Inbox Folder | Folder to sort. Empty = auto-discover. |
| Ignore Patterns | One glob per line. Skips matching files and folders. |
| Manifest Filename | Name of the vault manifest. Default: `_manifest.md`. |

## Review UI

Clean, sort, and chat render in native Obsidian views — a docked sidebar pane or a centered modal, per the **Review container** setting. There is no browser tab and no server.

- **Clean review** — a modal shows the original and the cleaned content side by side. Accept writes the file and saves a `.bak` backup. Reject keeps the original.
- **Sort review** — a modal lists the placement decisions with scores and destination context.
- **Chat** — a modal shows the answer and the sources.

## Configuration

See `config.example.yaml`. Key settings:

- `api.base_url` — API endpoint.
- `api.api_key` — API key. Optional; falls back to an env var.
- `embedding.model` — model for embeddings.
- `embedding.dimensions` — dimension count.
- `agent.model` — model for agent calls.
- `manifest.filename` — manifest file name.
- `preview.enabled` — review-before-write for clean.
- `preview.ttl_minutes` — how long a pending review stays valid.
- `query.top_k` — default result count.
- `index.warn_mb` — warn (in the devtools log) when the index file exceeds this size. sql.js holds ~10× the file size in RAM while building, so a large index is also a RAM event.

## Exclusion

Set the ignore patterns in the plugin Settings tab. The plugin skips matching files and folders during indexing and sorting. The format matches `.gitignore`.

## Security model — vault confinement

Every file operation in the plugin routes through one synchronous confinement layer, `src/io/vault_io.ts` (`VaultIO`). It accepts only vault-relative paths and enforces two guards before any I/O:

1. **Path normalization** — absolute paths and parent (`..`) traversal are rejected.
2. **Realpath verification** — the deepest existing ancestor of a target must resolve at-or-inside the vault root, which defeats symlink escapes (a symlink inside the vault pointing outside).

The plugin writes only inside the vault: the index at `.note-maintainer/index.db`, pending reviews at `.note-maintainer/pending`, the sort journal at `.note-maintainer/sort-journal.jsonl`, the active chat session at `.note-maintainer/chat/session-*.jsonl` (one per chat tab, deleted when the tab closes), `.bak` backups beside edited notes, and atomic `.tmp-*` files beside their targets. Plugin settings are stored by Obsidian via `loadData`.

The index is read and written through Obsidian's vault adapter (`app.vault.adapter`), never through a native module or a raw path. The sql.js engine runs inside a disposable Web Worker that is spawned per GraphRAG execution and terminated when the execution finishes — the worker frees the WASM heap, which sql.js never shrinks in-process.

## Version control (git-managed vaults)

All generated data lives under the single `.note-maintainer/` directory, so one ignore rule keeps it out of version control:

```gitignore
.note-maintainer/
```

Also consider ignoring Obsidian's own per-user state if your vault is committed or shared: `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and cache directories. The plugin's Settings-tab config (`data.json` under `.obsidian/plugins/obsidian-vault-ease-of-maintenance/`) may hold personal API settings — for shared/committed vaults, ignore it and keep secrets in your own `config.yaml` (see [Configuration](#configuration)) or environment variables instead.

## Chat modes — automatic tool-call detection

The chat agent auto-detects at startup whether the configured model can emit tool calls (one tiny probe call, cached per model):

- **Agentic mode** — the model calls `search_index`/`cite_source` itself. Used when tool calling is detected.
- **Retrieval fallback mode** — models that cannot call tools (small/quantized models) still get grounded answers: the plugin embeds your question and scans the index deterministically, and the model only writes an answer over the retrieved notes. You are notified once at startup which mode is active; a failed probe (model unreachable, fresh install) stays silent.

## Important Files

| Path | Role |
|---|---|
| `main.ts` | Plugin entry. Registers commands and settings. |
| `src/config.ts` | Settings types and API key resolution. |
| `src/indexer/scanner.ts` | Scans the vault for markdown files. |
| `src/indexer/chunker.ts` | Splits notes into header sections. |
| `src/indexer/embedder.ts` | Calls the embeddings API. |
| `src/indexer/entity_extractor.ts` | Extracts wikilinks, tags, and phrases. |
| `src/indexer/db.ts` | Async facade — the only DB entry point (sql.js + disposable worker). |
| `src/indexer/db_worker/` | sql.js engine, typed worker protocol, and the worker bundle. |
| `src/indexer/db_host.ts` | Main-thread host: vault-adapter I/O, browser worker, wasm loading. |
| `src/indexer/manifest.ts` | Parses `_manifest.md`. |
| `src/indexer/indexer.ts` | Orchestrates the indexing pipeline. |
| `src/agent/engine.ts` | Deterministic primitives: file registry, validators, journal, receipts. |
| `src/agent/conversation.ts` | Shared conversation store (chat + clarify namespaces, bounded history). |
| `src/agent/clarify.ts` | Portable clarification harness: read manifest, detect uncovered folders, ask (injectable question source), propose ops, diff, guarded write. |
| `src/agent/tools.ts` | Agent tools, including `apply_edits`, the `clarify` tool, and the `withClarify` compose helper. |
| `src/chat-review.ts` | Chat renderer — message list, in-flight answer mode for `clarify` calls, and the manifest diff accept/reject card. |
| `src/io/vault_io.ts` | Vault-confined sync file layer — the only place `fs` appears. |
| `src/agent/llm_client.ts` | API transport for local, OpenAI, and OpenRouter providers. |
| `src/agent/llm.ts` | Chat loop with tool calling. |
| `src/agent/runtime.ts` | Orchestrators: build, clean, sort, chat. |
| `src/preview/pending.ts` | Stores pending review state. |
| `tests/` | Vitest suite. |

## When to Rebuild
If you've cloned this repo and looking to manually build the project, run the follow `./build-plugin.sh --all` or remove the `--all` flag and specific the specific vault you want.

| Change | Rebuild? | Why |
|---|---|---|
| `main.ts` or `src/*.ts` | Yes | Must compile to `main.js` before Obsidian loads it. |
| `styles.css` | No | Loaded at startup. Reload Obsidian only. |
| `manifest.json` | No | Loaded once at startup. Reload Obsidian only. |
