// Vault-comprehension state file paths — single source of truth for where the
// reading-notebook artifacts live (all under .note-maintainer/, the existing
// gitignored agent-state dir — see .gitignore and the sort journal).

export const COMPREHENSION_DIR = ".note-maintainer";

/** Assumption ledger — the agent's reading notebook (add/score/delete/print). */
export const LEDGER_FILENAME = `${COMPREHENSION_DIR}/comprehension-ledger.json`;

/** Phase/status/tool-budget state — resume point for the next invocation. */
export const STATE_FILENAME = `${COMPREHENSION_DIR}/comprehension-state.json`;

/** Batch-skim mtime cache — re-runs only re-derive changed files. */
export const SKIM_CACHE_FILENAME = `${COMPREHENSION_DIR}/comprehension-skim-cache.json`;

/** Durable vault summary card — later agent sessions load it instantly. */
export const SUMMARY_FILENAME = `${COMPREHENSION_DIR}/vault-summary.md`;
