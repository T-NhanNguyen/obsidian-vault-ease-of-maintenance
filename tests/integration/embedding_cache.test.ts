// Integration tests — the content-hash embedding cache end-to-end (handoff:
// "Content-hash embedding cache + unit-level resume"). Builds a real index
// through Indexer.build (counting FakeEmbedder + temp vault files on the
// real fs) while the DB AND the cache sidecar live in an in-memory host
// (MemIO — the same host shape db_upgrade.test.ts uses). Pins:
//   1. A second full build over unchanged content issues ZERO embed calls
//      (the regression pin: full rebuild pays only for new text).
//   2. incremental() re-embeds ONLY the changed section — unchanged sections
//      are served from the cache.
//   3. A dimensions change triggers a full re-embed AND rewrites the cache
//      stamp (the 1536→768 invalidation, made structural).
//   4. Drop-and-return: a build that flushed file A's vectors and then
//      "crashed" (DB never exported) re-runs and serves file A from the
//      cache — the embedder never sees its text again.

import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Indexer } from "../../src/indexer/indexer";
import { EmbeddingCache } from "../../src/indexer/embedding_cache";
import type { DbChannel, DbFileIO, DbHost } from "../../src/indexer/db_host";
import type { DbMethodMap, DbMethodName } from "../../src/indexer/db_worker/protocol";
import { DbWorkerCore } from "../../src/indexer/db_worker/worker_core";
import { Settings } from "../../src/config";

// ---------------------------------------------------------------------------
// Harness — MemIO host (in-memory DB + cache sidecar), real-fs vault files
// ---------------------------------------------------------------------------

class MemIO implements DbFileIO {
  readonly files = new Map<string, Uint8Array>();

  async exists(absPath: string): Promise<boolean> {
    return this.files.has(absPath);
  }

  async readBinary(absPath: string): Promise<Uint8Array> {
    const bytes = this.files.get(absPath);
    if (!bytes) throw new Error(`ENOENT: ${absPath}`);
    return bytes;
  }

  async writeBinaryAtomic(absPath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(absPath, bytes);
  }

  async mkdirp(_absPath: string): Promise<void> {}

  async rename(_fromAbs: string, _toAbs: string): Promise<void> {}

  async listFiles(_absDir: string): Promise<string[]> {
    return [];
  }
}

class CoreChannel implements DbChannel {
  private readonly core = new DbWorkerCore(null);

  async open(dbBytes: Uint8Array | null): Promise<{ needsRebuild: boolean }> {
    return this.core.open(dbBytes);
  }

  async call<K extends DbMethodName>(
    method: K,
    ...args: DbMethodMap[K]["args"]
  ): Promise<DbMethodMap[K]["result"]> {
    return this.core.call(method, args) as DbMethodMap[K]["result"];
  }

  async close(): Promise<Uint8Array | null> {
    return this.core.close();
  }

  dispose(): void {
    this.core.dispose();
  }
}

function inMemoryHost(io: MemIO): DbHost {
  return {
    io,
    loadWasmBinary: async () => null,
    createChannel: async () => new CoreChannel(),
  };
}

/** Records every text the embedder was asked to embed (HTTP stand-in). */
class CountingEmbedder extends FakeEmbedder {
  readonly calls: string[] = [];

  constructor(dimensions: number) {
    super(dimensions);
  }

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    return super.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls.push(...texts);
    // Call super.embed directly (not this.embed) — FakeEmbedder.embedBatch
    // dispatches through this.embed, which would double-count the calls.
    return Promise.all(texts.map((t) => super.embed(t)));
  }
}

// Absolute MemIO keys for the DB + cache sidecar (MemIO keys on strings).
const DB_PATH = "/mem/vault/.note-maintainer/index.db";
const CACHE_PATH = "/mem/vault/.note-maintainer/embedding-cache.json";

function makeSettings(vaultPath: string): Settings {
  return {
    vaultPath,
    configDir: "",
    pluginDir: "",
    dbPath: DB_PATH,
    inboxFolder: "",
    ignorePatterns: "",
    api: { baseUrl: "http://localhost:9999/v1", apiKey: "test-key" },
    embedding: { model: "test", dimensions: 64 },
    manifest: { filename: "_manifest.md" },
    query: { topK: 5, depth: 1, maxFanOut: 8, maxSeeds: 8, topReports: 3 },
    agent: { model: "test", thinking: { chat: false, build: false, sort: false } },
    preview: { enabled: true, ttlMinutes: 30 },
    index: { warnMb: 256 },
    graph: {
      clusterThreshold: 0.5,
      inferredThreshold: 0.7,
      inferredMaxEdgesPerSection: 3,
    },
    reports: { contextCapTokens: 3000 },
    extraction: { contextCapTokens: 3000 },
  };
}

/** One vault (real fs) + one MemIO host + settings. Shared across runs. */
async function makeHarness(
  files: Record<string, string>,
): Promise<{ settings: Settings; vaultDir: string; io: MemIO; host: DbHost }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-emb-cache-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const io = new MemIO();
  return { settings: makeSettings(vaultDir), vaultDir, io, host: inMemoryHost(io) };
}

/** A fresh Indexer over an existing harness (fresh counting embedder). */
function makeIndexer(
  h: { settings: Settings; host: DbHost },
  dimensions = 64,
): { indexer: Indexer; embedder: CountingEmbedder } {
  const embedder = new CountingEmbedder(dimensions);
  return { indexer: new Indexer(h.settings, embedder, undefined, undefined, h.host), embedder };
}

/** sha1 of the trimmed section text — mirrors src/indexer/chunker.ts. */
function sectionHash(text: string): string {
  return crypto.createHash("sha1").update(text.trim()).digest("hex");
}

function readCacheFile(io: MemIO): { model: string; dimensions: number; entries: Record<string, number[]> } {
  const raw = io.files.get(CACHE_PATH);
  expect(raw).toBeDefined();
  return JSON.parse(new TextDecoder().decode(raw!));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmbeddingCache end-to-end", () => {
  it("a second full build over unchanged content issues ZERO embed calls", async () => {
    const h = await makeHarness({
      "a.md": "# Alpha\n\nbloom energy fuel cells overview.\n\n## Deep\n\nNotes on the section structure.\n",
      "b.md": "# Beta\n\nbitcoin mining halving rewards network.\n",
    });

    const first = makeIndexer(h);
    await first.indexer.build();
    expect(first.embedder.calls.length).toBeGreaterThan(0);

    // Re-run the same build (fresh embedder, same vault, same cache sidecar).
    const second = makeIndexer(h);
    await second.indexer.build();
    expect(second.embedder.calls).toEqual([]);
  });

  it("incremental re-embeds only the changed section", async () => {
    const h = await makeHarness({
      "a.md": "# A\n\nBody A.\n\n## Deep\n\nDeep body A.\n",
      "b.md": "# B\n\nBody B.\n",
    });

    const first = makeIndexer(h);
    await first.indexer.build();

    // Edit ONLY the Deep section of a.md — the Intro section and b.md are
    // textually identical, so their hashes hit the cache.
    fs.writeFileSync(
      path.join(h.vaultDir, "a.md"),
      "# A\n\nBody A.\n\n## Deep\n\nDeep body A, edited.\n",
    );

    const inc = makeIndexer(h);
    await inc.indexer.incremental();
    expect(inc.embedder.calls).toEqual(["Deep body A, edited."]);
  });

  it("a dimensions change re-embeds everything and rewrites the cache stamp", async () => {
    const h = await makeHarness({
      "a.md": "# A\n\nbloom energy fuel cells overview.\n",
    });

    const first = makeIndexer(h, 64);
    await first.indexer.build();
    expect(first.embedder.calls).toEqual(["bloom energy fuel cells overview."]);
    expect(readCacheFile(h.io).dimensions).toBe(64);

    // Model/dimension change (the 1536→768 lesson): a different vector space
    // must never reuse the stored vectors — one fresh full embed pass.
    const swapped: Settings = { ...h.settings, embedding: { model: "test", dimensions: 32 } };
    const secondEmbedder = new CountingEmbedder(32);
    const secondIndexer = new Indexer(swapped, secondEmbedder, undefined, undefined, h.host);
    await secondIndexer.build();
    expect(secondEmbedder.calls).toEqual(["bloom energy fuel cells overview."]);

    // The sidecar's stamp is rewritten for the new vector space.
    const file = readCacheFile(h.io);
    expect(file.model).toBe("test");
    expect(file.dimensions).toBe(32);
    expect(Object.keys(file.entries)).toHaveLength(1);
  });

  it("an interrupted build re-runs and serves the flushed file from the cache", async () => {
    const h = await makeHarness({
      "a.md": "# A\n\nBody A.\n",
      "b.md": "# B\n\nBody B.\n",
    });

    // "Crash" checkpoint: file A's vectors were flushed to the sidecar, then
    // the build died before the DB was ever exported (close() never ran — no
    // index.db in MemIO).
    const cache = new EmbeddingCache(h.io, CACHE_PATH);
    await cache.load({ model: "test", dimensions: 64 });
    cache.put(sectionHash("Body A."), await new FakeEmbedder(64).embed("Body A."));
    await cache.flush();
    expect(h.io.files.has(DB_PATH)).toBe(false);

    // Re-run: file A is served from the cache (zero HTTP for it); only file
    // B — never embedded before — reaches the embedder.
    const { indexer, embedder } = makeIndexer(h);
    await indexer.build();
    expect(embedder.calls).toEqual(["Body B."]);
  });
});
