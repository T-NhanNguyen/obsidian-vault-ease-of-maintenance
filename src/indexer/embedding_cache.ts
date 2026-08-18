// Content-hash embedding cache — the drop-and-return checkpoint for the
// embedding pass (handoff: "Content-hash embedding cache + unit-level
// resume"). Today a full build() calls clearAll() and re-embeds every
// section over HTTP; an interrupted build loses all embedding work because
// the index is exported once at close(). This cache makes the embedding
// pass pay only for NEW text:
//
//   - Key   = SECTIONS.content_hash (sha1 of the exact text the embedder
//             receives) — two identical sections share one vector, a free
//             dedupe win.
//   - Stamp = model + dimensions. A stamp mismatch means the stored vectors
//             live in a different vector space → treated as empty and
//             rewritten on the next flush (the 1536→768 lesson made
//             structural).
//   - I/O   = DbFileIO.writeBinaryAtomic (temp + rename) — an interrupt
//             mid-flush leaves an orphaned temp file that the next load()
//             simply ignores. Nothing in-flight is ever trusted.
//
// The sidecar lives NEXT TO index.db (not inside it): it must survive both
// clearAll() and retireLegacyIndex() (which moves only index.db* into
// legacy/). A DB_ENGINE_VERSION bump wipes the index file itself, so the
// checkpoint can never live in-DB — this is why the cache is a sibling file.

import type { DbFileIO } from "./db_host";

/** The vector-space stamp a cache file is valid for. */
interface EmbeddingCacheStamp {
  model: string;
  dimensions: number;
}

/** On-disk shape of the sidecar. */
interface EmbeddingCacheFile {
  model: string;
  dimensions: number;
  entries: Record<string, number[]>;
}

export class EmbeddingCache {
  private readonly entries = new Map<string, number[]>();
  private model = "";
  private dimensions = 0;

  constructor(private readonly io: DbFileIO, private readonly cachePath: string) {}

  async load(stamp: EmbeddingCacheStamp): Promise<void> {
    this.entries.clear();
    try {
      if (!(await this.io.exists(this.cachePath))) {
        this.markFresh(stamp);
        return;
      }
      const raw = await this.io.readBinary(this.cachePath);
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as EmbeddingCacheFile;
      if (parsed.model !== stamp.model || parsed.dimensions !== stamp.dimensions) {
        this.markFresh(stamp); // different vector space — invalidate
        return;
      }
      for (const [hash, vec] of Object.entries(parsed.entries)) {
        this.entries.set(hash, vec);
      }
      this.model = parsed.model;
      this.dimensions = parsed.dimensions;
    } catch {
      // Unparseable / partial / structurally-wrong file — start clean, never
      // crash the build on a corrupt cache.
      this.markFresh(stamp);
    }
  }

  private markFresh(stamp: EmbeddingCacheStamp): void {
    this.entries.clear();
    this.model = stamp.model;
    this.dimensions = stamp.dimensions;
  }

  get(contentHash: string): number[] | null {
    return this.entries.get(contentHash) ?? null;
  }

  /**
   * Cache a vector under its section content hash. Empty vectors are NEVER
   * cached: a transient embed failure must not poison the cache with a zero
   * vector that a later run would "reuse" as a hit.
   */
  put(contentHash: string, embedding: number[]): void {
    if (!embedding || embedding.length === 0) return;
    this.entries.set(contentHash, embedding);
  }

  async flush(): Promise<void> {
    const file: EmbeddingCacheFile = {
      model: this.model,
      dimensions: this.dimensions,
      entries: Object.fromEntries(this.entries),
    };
    await this.io.writeBinaryAtomic(
      this.cachePath,
      new TextEncoder().encode(JSON.stringify(file)),
    );
  }
}
