// Embedding vector math — the pure core of the embedding concern: BLOB
// encode/decode for the SQLite storage layer, cosine similarity, and
// vector-search ranking.
//
// This module is PURE by construction: no config, no HTTP, no Node builtins.
// It is imported by BOTH the sql.js worker (sqljs_database) and the main
// thread, so it must never pull in config/http/embedder. The HTTP API client
// (Embedder) lives in ./embedder.ts and is main-thread only.

import type { SearchResult, SectionSearchRow } from "./db_worker/types";

/** A SECTIONS row joined with its FILES row — the raw input to ranking.
 * Field names match the SQL column names (snake_case) from getAsObject().
 * This is SectionSearchRow plus the embedding blob (the vector-search read). */
export interface EmbeddingRow extends SectionSearchRow {
  embedding: Uint8Array | null;
}

/** Encode a float vector as a little-endian Float64 BLOB (SECTIONS.embedding). */
export function floatsToBlob(emb: number[]): Uint8Array {
  const bytes = new Uint8Array(emb.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < emb.length; i++) {
    view.setFloat64(i * 8, emb[i], true);
  }
  return bytes;
}

/** Decode a Float64 BLOB back to a float vector; null/empty → null. */
export function blobToFloats(blob: Uint8Array | null): number[] | null {
  if (!blob || blob.byteLength === 0) return null;
  // Copy to a fresh, 8-aligned buffer so the Float64Array view is always
  // safe regardless of the blob's byteOffset.
  const aligned = new Uint8Array(blob);
  const count = aligned.byteLength / 8;
  const view = new Float64Array(aligned.buffer);
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    result[i] = view[i];
  }
  return result;
}

/** Cosine similarity of two equal-length vectors; zero norms → 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0.0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Map a joined SECTIONS+FILES row to a SearchResult with the given score.
 * Shared by the pure-cosine ranker and the graph-search path (graph-only
 * hits carry the resolver's match score instead of a cosine score).
 */
export function rowToSearchResult(row: SectionSearchRow, score: number): SearchResult {
  return {
    nodeKey: row.node_key,
    fileId: row.file_id,
    filePath: row.file_id,
    headingPath: row.heading_path || "",
    headingText: row.heading_text || "",
    lineStart: row.line_start || 0,
    lineEnd: row.line_end || 0,
    text: row.text || "",
    contentHash: row.content_hash || "",
    fileContentHash: row.content_hash || "",
    contentType: row.content_type || "",
    rollupSummary: row.rollup_summary || "",
    title: row.title || "",
    score,
  };
}

/**
 * Vector search: score every row against the query embedding by cosine and
 * return the top-K as SearchResults, best first. Rows without a usable
 * embedding are skipped.
 */
export function rankByCosine(
  queryEmbedding: number[],
  rows: EmbeddingRow[],
  topK: number,
): SearchResult[] {
  const results: Array<[number, SearchResult]> = [];
  for (const row of rows) {
    const storedEmb = blobToFloats(row.embedding);
    if (!storedEmb || storedEmb.length === 0) continue;

    const score = cosineSimilarity(queryEmbedding, storedEmb);
    results.push([score, rowToSearchResult(row, score)]);
  }

  results.sort((a, b) => b[0] - a[0]);
  return results.slice(0, topK).map((r) => r[1]);
}
