// Unit tests for the content-hash embedding cache (src/indexer/embedding_cache.ts).
//
// Hand-computable expectations on a tiny in-memory file IO:
//   1. get/put round-trip; unknown hash → null.
//   2. flush → a fresh cache over the same IO reloads the entries (the
//      drop-and-return checkpoint contract).
//   3. Stamp mismatch (model OR dimensions) → entries treated as empty AND
//      the next flush rewrites the stamp (the 1536→768 lesson).
//   4. Corrupt / structurally-wrong JSON → empty, never throws.
//   5. Empty vectors are never cached — a transient embed failure cannot
//      poison the sidecar with a zero vector.

import { describe, it, expect } from "vitest";
import { EmbeddingCache } from "../../src/indexer/embedding_cache";
import type { DbFileIO } from "../../src/indexer/db_host";

/** Minimal in-memory DbFileIO — enough for the cache contract. */
class MemFileIO implements DbFileIO {
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

const STAMP = { model: "test-model", dimensions: 64 };
const CACHE_PATH = "/vault/.note-maintainer/embedding-cache.json";

function readCacheFile(io: MemFileIO): { model: string; dimensions: number; entries: Record<string, number[]> } {
  const raw = io.files.get(CACHE_PATH);
  expect(raw).toBeDefined();
  return JSON.parse(new TextDecoder().decode(raw!));
}

describe("EmbeddingCache", () => {
  it("get returns null for an unknown hash; put then get round-trips", async () => {
    const cache = new EmbeddingCache(new MemFileIO(), CACHE_PATH);
    await cache.load(STAMP);

    expect(cache.get("nope")).toBeNull();

    cache.put("abc", [0.1, 0.2, 0.3]);
    expect(cache.get("abc")).toEqual([0.1, 0.2, 0.3]);
  });

  it("flush → a fresh cache over the same IO reloads the entries", async () => {
    const io = new MemFileIO();
    const first = new EmbeddingCache(io, CACHE_PATH);
    await first.load(STAMP);
    first.put("a", [1, 2, 3]);
    first.put("b", [4, 5, 6]);
    await first.flush();

    // A reloaded cache (the re-run of an interrupted build) sees the vectors.
    const second = new EmbeddingCache(io, CACHE_PATH);
    await second.load(STAMP);
    expect(second.get("a")).toEqual([1, 2, 3]);
    expect(second.get("b")).toEqual([4, 5, 6]);
  });

  it("a model change invalidates the cache and the next flush rewrites the stamp", async () => {
    const io = new MemFileIO();
    const first = new EmbeddingCache(io, CACHE_PATH);
    await first.load({ model: "old-model", dimensions: 64 });
    first.put("a", [1, 2, 3]);
    await first.flush();

    const second = new EmbeddingCache(io, CACHE_PATH);
    await second.load({ model: "new-model", dimensions: 64 });
    // Different vector space — stored vectors are never reused.
    expect(second.get("a")).toBeNull();

    second.put("b", [7, 8, 9]);
    await second.flush();

    const file = readCacheFile(io);
    expect(file.model).toBe("new-model");
    expect(file.dimensions).toBe(64);
    expect(file.entries).toEqual({ b: [7, 8, 9] });
  });

  it("a dimensions change invalidates the cache (same invalidation as model)", async () => {
    const io = new MemFileIO();
    const first = new EmbeddingCache(io, CACHE_PATH);
    await first.load({ model: "test-model", dimensions: 64 });
    first.put("a", [1, 2, 3]);
    await first.flush();

    const second = new EmbeddingCache(io, CACHE_PATH);
    await second.load({ model: "test-model", dimensions: 768 });
    expect(second.get("a")).toBeNull();
  });

  it("corrupt JSON loads as empty without throwing", async () => {
    const io = new MemFileIO();
    io.files.set(CACHE_PATH, new TextEncoder().encode("{this is not json"));
    const cache = new EmbeddingCache(io, CACHE_PATH);
    await expect(cache.load(STAMP)).resolves.toBeUndefined();
    expect(cache.get("a")).toBeNull();
  });

  it("structurally-wrong JSON (missing entries) loads as empty without throwing", async () => {
    const io = new MemFileIO();
    io.files.set(CACHE_PATH, new TextEncoder().encode('{"model":"test-model","dimensions":64}'));
    const cache = new EmbeddingCache(io, CACHE_PATH);
    await expect(cache.load(STAMP)).resolves.toBeUndefined();
    expect(cache.get("a")).toBeNull();
  });

  it("a missing cache file is fresh — load succeeds, put/flush creates it", async () => {
    const io = new MemFileIO();
    const cache = new EmbeddingCache(io, CACHE_PATH);
    await cache.load(STAMP);
    expect(cache.get("a")).toBeNull();

    cache.put("a", [1]);
    await cache.flush();
    expect(readCacheFile(io).entries).toEqual({ a: [1] });
  });

  it("empty vectors are never cached — a failed embed cannot poison the sidecar", async () => {
    const io = new MemFileIO();
    const cache = new EmbeddingCache(io, CACHE_PATH);
    await cache.load(STAMP);
    cache.put("empty", []);
    expect(cache.get("empty")).toBeNull();

    // A subsequent flush must NOT persist a zero vector as a "hit".
    cache.put("real", [0.5, -0.5]);
    await cache.flush();
    const reloaded = new EmbeddingCache(io, CACHE_PATH);
    await reloaded.load(STAMP);
    expect(reloaded.get("empty")).toBeNull();
    expect(reloaded.get("real")).toEqual([0.5, -0.5]);
  });
});
