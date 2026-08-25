// Derived-data clearing for the Settings tab (troubleshooting). Both clear
// buttons run one defensive per-file loop over a fixed vault-relative list:
// missing files are skipped (counted), a throwing remove is counted as
// failed, and the functions never throw. Only the listed files are touched —
// legacy/, the manifest, and the sort journal stay untouched.

import * as path from "path";
import { INDEX_DB_SUFFIX } from "../config";
import { EMBEDDING_CACHE_FILENAME } from "../indexer/indexer";
import {
  LEDGER_FILENAME,
  STATE_FILENAME,
  SKIM_CACHE_FILENAME,
  SUMMARY_FILENAME,
} from "../comprehension/paths";

/** Minimal vault-file IO the clear functions need — the Obsidian adapter
 * (app.vault.adapter) satisfies it. */
export interface ClearDataIO {
  exists(rel: string): Promise<boolean>;
  remove(rel: string): Promise<void>;
}

/** Outcome of one clear run, per known file. */
export interface ClearResult {
  removed: string[];
  missing: string[];
  failed: string[];
}

// The sql.js sidecars sql.js appends to the DB filename (see db_host.ts).
const INDEX_WAL_SUFFIX = `${INDEX_DB_SUFFIX}-wal`;
const INDEX_SHM_SUFFIX = `${INDEX_DB_SUFFIX}-shm`;
const EMBEDDING_CACHE_REL = path.posix.join(
  path.posix.dirname(INDEX_DB_SUFFIX),
  EMBEDDING_CACHE_FILENAME,
);

/** The GraphRAG index file set (index.db, sidecars, embedding cache). */
const INDEX_FILES: string[] = [INDEX_DB_SUFFIX, INDEX_WAL_SUFFIX, INDEX_SHM_SUFFIX, EMBEDDING_CACHE_REL];

/** The comprehension artifact set (ledger, state, skim cache, summary card). */
const COMPREHENSION_FILES: string[] = [
  LEDGER_FILENAME,
  STATE_FILENAME,
  SKIM_CACHE_FILENAME,
  SUMMARY_FILENAME,
];

async function clearFiles(io: ClearDataIO, rels: string[]): Promise<ClearResult> {
  const result: ClearResult = { removed: [], missing: [], failed: [] };
  for (const rel of rels) {
    let exists = false;
    try {
      exists = await io.exists(rel);
    } catch {
      // exists() failing counts as missing — there is nothing to remove.
    }
    if (!exists) {
      result.missing.push(rel);
      continue;
    }
    try {
      await io.remove(rel);
      result.removed.push(rel);
    } catch {
      result.failed.push(rel);
    }
  }
  return result;
}

/** Delete the GraphRAG index. legacy/ and all other vault files are
 * untouched; the next build recreates the index from scratch. */
export async function clearVaultIndex(io: ClearDataIO): Promise<ClearResult> {
  return clearFiles(io, INDEX_FILES);
}

/** Delete the comprehension artifacts. Removing the summary card forces a
 * fresh comprehension run on the next build (the run-once reuse rule). */
export async function clearComprehensionData(io: ClearDataIO): Promise<ClearResult> {
  return clearFiles(io, COMPREHENSION_FILES);
}
