# Vault Ease of Maintenance

GraphRAG indexer + LLM-driven agents for Obsidian markdown vaults.

This plugin keeps an Obsidian vault easy to maintain. It builds a GraphRAG index of the notes in the vault. It uses LLM agents to clean notes, sort the inbox, and answer questions. Everything runs inside Obsidian. You do not need Python, a server, or Docker.

## Quick Start

### 1. Set the API key

The indexer and agents call an OpenAI-compatible API. Use OpenAI, OpenRouter, or a local server such as OMLX.

Set the key in one of these places:

1. Plugin Settings → API Key.
2. `api.api_key` in `config.yaml` (repo-local, plugin dir).
3. An environment variable: `OMLX_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

The plugin checks these sources in this order.

### 2. Configure the plugin

The **Settings tab is the main configuration** and always wins. Resolution order:

```
code defaults ← <pluginDir>/config.yaml ← Settings tab (MAIN)
```

- **Plugin-store users:** configure the Settings tab only (they have no `config.yaml`).
- **Repo users / local dev:** copy `config.example.yaml` → `config.yaml` in the plugin folder.
- There is **no vault-level config file** by design — vaults may live in shared/company databases where API keys and parameters must not be stored. Config lives only in the Settings tab and the repo's `config.yaml`. See `config.example.yaml` for all options.

### 3. Build the index

Run the command **Build GraphRAG index**. The plugin scans the vault, splits notes into header sections, extracts entities, and creates embeddings. It stores the index at `{vault}/.note-maintainer/index.db`.

If no `_manifest.md` exists, the plugin derives one from the index. Review it before you run sort.

### 4. Use the agents

- **Clean current note** — clean the note you have open. The plugin proposes edits. Review the diff in the modal, then accept or reject.
- **Sort inbox** — triage the inbox. The plugin returns placement decisions. It does not move files without your approval.
- **Chat with your vault** — ask a question. The plugin answers from the index with cited sources.

### 5. Install the plugin

1. Run `npm run build` in the repo root. This writes `main.js`.
2. Create the folder `<vault>/.obsidian/plugins/obsidian-vault-ease-of-maintenance/`.
3. Copy `main.js`, `manifest.json`, `styles.css`, **and the `node_modules` folder** into that folder. The Build command needs `better-sqlite3` (the SQLite binding) and it is **not** shipped with the build — if it is missing, Build fails with
   `Cannot find module 'better-sqlite3' (require stack: electron/js2c/renderer_init)`.
   Easiest: run `./build-plugin.sh <vault-path>` — it builds and installs everything, including `node_modules`.
4. Enable the plugin in Obsidian: Settings → Community Plugins.

## Commands

| Command | Purpose |
|---|---|
| Build GraphRAG index | Full index rebuild from scratch. |
| Clean current note | Run the cleanup agent on the open note. |
| Sort inbox | Run the triage agent on the inbox. |
| Chat with your vault | Ask a question about the vault. |

## Plugin Settings

| Setting | Purpose |
|---|---|
| API Key | Key for the OpenAI-compatible API. Optional when you use an env var. |
| API Base URL | Base URL of the API. |
| Agent Model | Model for clean, sort, and chat. |
| Embedding Model | Model for embeddings. |
| Inbox Folder | Folder to sort. Empty = auto-discover. |
| Ignore Patterns | One glob per line. Skips matching files and folders. |
| Manifest Filename | Name of the vault manifest. Default: `_manifest.md`. |

## Review UI

Clean, sort, and chat render in native Obsidian views. There is no browser tab and no server.

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

## Exclusion

Set the ignore patterns in the plugin Settings tab. The plugin skips matching files and folders during indexing and sorting. The format matches `.gitignore`.

## Security model — vault confinement

Every file operation in the plugin routes through one synchronous confinement layer, `src/io/vault_io.ts` (`VaultIO`). It accepts only vault-relative paths and enforces two guards before any I/O:

1. **Path normalization** — absolute paths and parent (`..`) traversal are rejected.
2. **Realpath verification** — the deepest existing ancestor of a target must resolve at-or-inside the vault root, which defeats symlink escapes (a symlink inside the vault pointing outside).

The plugin writes only inside the vault: the index at `.note-maintainer/index.db`, pending reviews at `.note-maintainer/pending`, the sort journal at `.note-maintainer/sort-journal.jsonl`, `.bak` backups beside edited notes, and atomic `.tmp-*` files beside their targets. Plugin settings are stored by Obsidian via `loadData`. The only native module, `better-sqlite3`, opens the DB path inside the vault (verified via `VaultIO.absPath`); it is the documented exception.

## Important Files

| Path | Role |
|---|---|
| `main.ts` | Plugin entry. Registers commands and settings. |
| `src/config.ts` | Settings types and API key resolution. |
| `src/indexer/scanner.ts` | Scans the vault for markdown files. |
| `src/indexer/chunker.ts` | Splits notes into header sections. |
| `src/indexer/embedder.ts` | Calls the embeddings API. |
| `src/indexer/entity_extractor.ts` | Extracts wikilinks, tags, and phrases. |
| `src/indexer/db.ts` | SQLite index (better-sqlite3). |
| `src/indexer/manifest.ts` | Parses `_manifest.md`. |
| `src/indexer/indexer.ts` | Orchestrates the indexing pipeline. |
| `src/agent/engine.ts` | Deterministic primitives: file registry, validators, journal, receipts. |
| `src/io/vault_io.ts` | Vault-confined sync file layer — the only place `fs` appears. |
| `src/agent/llm_client.ts` | API transport for local, OpenAI, and OpenRouter providers. |
| `src/agent/llm.ts` | Chat loop with tool calling. |
| `src/agent/tools.ts` | Agent tools, including `apply_edits`. |
| `src/agent/runtime.ts` | Orchestrators: build, clean, sort, chat. |
| `src/preview/pending.ts` | Stores pending review state. |
| `tests/` | Vitest suite. |

## When to Rebuild

| Change | Rebuild? | Why |
|---|---|---|
| `main.ts` or `src/*.ts` | Yes | Must compile to `main.js` before Obsidian loads it. |
| `styles.css` | No | Loaded at startup. Reload Obsidian only. |
| `manifest.json` | No | Loaded once at startup. Reload Obsidian only. |
