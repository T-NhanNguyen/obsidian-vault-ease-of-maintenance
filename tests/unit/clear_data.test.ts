// Derived-data clear actions (Settings-tab troubleshooting buttons) — the
// exact file sets, the missing-skip behavior, the never-throw guarantee, and
// the guarantee that nothing outside the known lists is ever touched.

import { describe, it, expect } from "vitest";
import {
  clearVaultIndex,
  clearComprehensionData,
  type ClearDataIO,
} from "../../src/io/clear_data";

const INDEX_DB = ".note-maintainer/index.db";
const INDEX_WAL = ".note-maintainer/index.db-wal";
const INDEX_SHM = ".note-maintainer/index.db-shm";
const EMBEDDING_CACHE = ".note-maintainer/embedding-cache.json";
const LEDGER = ".note-maintainer/comprehension-ledger.json";
const STATE = ".note-maintainer/comprehension-state.json";
const SKIM_CACHE = ".note-maintainer/comprehension-skim-cache.json";
const SUMMARY_CARD = ".note-maintainer/vault-summary.md";

/** Unrelated files that must never be touched by either clear action. */
const UNRELATED = [
  ".note-maintainer/sort-journal.jsonl",
  ".note-maintainer/legacy/index.db",
  "_manifest.md",
  "some/note.md",
];

class FakeClearDataIO implements ClearDataIO {
  readonly removed: string[] = [];
  private readonly failRemove: Set<string>;
  private readonly failExists: Set<string>;

  constructor(
    private readonly existing: Set<string>,
    failRemove: string[] = [],
    failExists: string[] = [],
  ) {
    this.failRemove = new Set(failRemove);
    this.failExists = new Set(failExists);
  }

  async exists(rel: string): Promise<boolean> {
    if (this.failExists.has(rel)) throw new Error(`exists failed: ${rel}`);
    return this.existing.has(rel);
  }

  async remove(rel: string): Promise<void> {
    if (this.failRemove.has(rel)) throw new Error(`remove failed: ${rel}`);
    this.removed.push(rel);
  }
}

describe("clearVaultIndex", () => {
  it("removes exactly the index, its sidecars, and the embedding cache", async () => {
    const io = new FakeClearDataIO(
      new Set([INDEX_DB, INDEX_WAL, INDEX_SHM, EMBEDDING_CACHE, ...UNRELATED]),
    );

    const result = await clearVaultIndex(io);

    expect(result.removed).toEqual([INDEX_DB, INDEX_WAL, INDEX_SHM, EMBEDDING_CACHE]);
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(io.removed).not.toEqual(expect.arrayContaining(UNRELATED));
  });

  it("skips missing files and reports them", async () => {
    const io = new FakeClearDataIO(new Set([INDEX_DB]));

    const result = await clearVaultIndex(io);

    expect(result.removed).toEqual([INDEX_DB]);
    expect(result.missing).toEqual([INDEX_WAL, INDEX_SHM, EMBEDDING_CACHE]);
  });

  it("is a no-op when nothing exists and never calls remove", async () => {
    const io = new FakeClearDataIO(new Set());

    const result = await clearVaultIndex(io);

    expect(result.removed).toEqual([]);
    expect(result.missing).toEqual([INDEX_DB, INDEX_WAL, INDEX_SHM, EMBEDDING_CACHE]);
    expect(io.removed).toEqual([]);
  });

  it("counts a throwing remove as failed without aborting the rest", async () => {
    const io = new FakeClearDataIO(new Set([INDEX_DB, INDEX_WAL]), [INDEX_WAL]);

    const result = await clearVaultIndex(io);

    expect(result.removed).toEqual([INDEX_DB]);
    expect(result.failed).toEqual([INDEX_WAL]);
    expect(result.missing).toEqual([INDEX_SHM, EMBEDDING_CACHE]);
  });

  it("counts a throwing exists as missing", async () => {
    const io = new FakeClearDataIO(new Set([INDEX_DB]), [], [INDEX_DB]);

    const result = await clearVaultIndex(io);

    expect(result.removed).toEqual([]);
    expect(result.missing).toEqual([INDEX_DB, INDEX_WAL, INDEX_SHM, EMBEDDING_CACHE]);
  });
});

describe("clearComprehensionData", () => {
  it("removes exactly the ledger, state, skim cache, and summary card", async () => {
    const io = new FakeClearDataIO(
      new Set([LEDGER, STATE, SKIM_CACHE, SUMMARY_CARD, ...UNRELATED]),
    );

    const result = await clearComprehensionData(io);

    expect(result.removed).toEqual([LEDGER, STATE, SKIM_CACHE, SUMMARY_CARD]);
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(io.removed).not.toEqual(expect.arrayContaining(UNRELATED));
  });

  it("never touches the index files", async () => {
    const io = new FakeClearDataIO(new Set([INDEX_DB, EMBEDDING_CACHE, SUMMARY_CARD]));

    const result = await clearComprehensionData(io);

    expect(result.removed).toEqual([SUMMARY_CARD]);
    expect(io.removed).not.toContain(INDEX_DB);
    expect(io.removed).not.toContain(EMBEDDING_CACHE);
  });

  it("is a no-op when nothing exists", async () => {
    const io = new FakeClearDataIO(new Set());

    const result = await clearComprehensionData(io);

    expect(result.removed).toEqual([]);
    expect(result.missing).toEqual([LEDGER, STATE, SKIM_CACHE, SUMMARY_CARD]);
  });
});
