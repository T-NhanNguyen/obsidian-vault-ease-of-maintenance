// Verify — the RAG verification phase of the vault-comprehension pipeline
// (GraphChat design, milestone 2). Pulls the top open assumptions, asks
// 2–4 precise questions as ONE multi-query batch, and retrieves top-k=3
// snippets with locations per question through the plugin's hybrid search
// (graph_search.hybridQuery). The runtime scores assumptions up/down against
// these hits and attaches the locations as evidence.

import type { IEmbedder } from "../indexer/embedder";
import { hybridQuery, type HybridQueryDb } from "../indexer/graph_search";
import type { SearchResult } from "../indexer/db_worker/types";

export interface VerifyHit {
  path: string;
  heading: string;
  lines: [number, number];
  snippet: string;
  score: number;
}

export interface VerifyQuestionResult {
  question: string;
  hits: VerifyHit[];
}

export interface VerifyResult {
  /** "missing" when the index holds no sections — the runtime then skips
   * verification and confirms on skim+ledger coverage alone (the cold build
   * path has no index yet; the build that follows creates it). */
  index: "ok" | "missing";
  results: VerifyQuestionResult[];
}

function toVerifyHit(result: SearchResult): VerifyHit {
  return {
    path: result.filePath,
    heading: result.headingPath,
    lines: [result.lineStart, result.lineEnd],
    snippet: result.text,
    score: result.score,
  };
}

/** Batch verification: one index availability probe, then top-k retrieval
 * per question. Empty index → index: "missing" (no per-question work). */
export async function verifyQuestions(
  embedder: IEmbedder,
  db: HybridQueryDb,
  questions: string[],
  topK: number = 3,
): Promise<VerifyResult> {
  const sections = await db.getSectionKeys();
  if (sections.length === 0) {
    return { index: "missing", results: [] };
  }
  const results: VerifyQuestionResult[] = [];
  for (const question of questions) {
    const hits = await hybridQuery(embedder, db, question, topK);
    results.push({ question, hits: hits.map(toVerifyHit) });
  }
  return { index: "ok", results };
}
