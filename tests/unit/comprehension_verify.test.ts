// Verify-phase tests — the batch RAG verification through hybridQuery:
// index-availability probing, top-k retrieval with locations per question,
// and empty-index handling (→ index "missing" → insufficient_evidence).

import { describe, it, expect } from "vitest";
import { verifyQuestions } from "../../src/comprehension/verify";
import type { IEmbedder } from "../../src/indexer/embedder";
import type { HybridQueryDb } from "../../src/indexer/graph_search";
import type { SearchResult, SectionKeyRow } from "../../src/indexer/db_worker/types";

const FAKE_EMBEDDER: IEmbedder = {
  embed: async () => [0.1, 0.2],
  embedBatch: async () => [[0.1, 0.2]],
};

function makeResult(path: string, text: string, score: number): SearchResult {
  return {
    nodeKey: `${path}::Intro`,
    fileId: path,
    filePath: path,
    headingPath: "Intro",
    headingText: "Intro",
    lineStart: 1,
    lineEnd: 5,
    text,
    contentHash: "content-hash",
    fileContentHash: "file-hash",
    contentType: "section",
    rollupSummary: "",
    title: path,
    score,
  };
}

/** Minimal HybridQueryDb stub: scripted cosine hits per call (hybridQuery
 * short-circuits to the cosine tier when the graph is empty). */
class StubHybridDb implements HybridQueryDb {
  private call = 0;
  lastTopK = 0;

  constructor(
    private sections: SectionKeyRow[],
    private hitsByCall: SearchResult[][],
  ) {}

  async searchSimilar(_embedding: number[], topK: number): Promise<SearchResult[]> {
    this.lastTopK = topK;
    return this.hitsByCall[this.call++] ?? [];
  }
  async getSectionKeys(): Promise<SectionKeyRow[]> {
    return this.sections;
  }
  async getAllEntities() {
    return [];
  }
  async getSectionsForEntities() {
    return [];
  }
  async getWikilinkEdges() {
    return [];
  }
  async getSemanticEdges() {
    return [];
  }
  async getSectionsByKeys() {
    return [];
  }
}

describe("verifyQuestions", () => {
  it("reports index missing when the index holds no sections", async () => {
    const db = new StubHybridDb([], []);
    const result = await verifyQuestions(FAKE_EMBEDDER, db, ["q1"], 3);
    expect(result).toEqual({ index: "missing", results: [] });
  });

  it("retrieves top-k hits with locations per question", async () => {
    const sections: SectionKeyRow[] = [{ node_key: "a/one.md::Intro", file_id: "a/one.md", heading_path: "Intro", heading_text: "Intro" }];
    const db = new StubHybridDb(sections, [
      [makeResult("a/one.md", "snippet one", 0.9), makeResult("b/two.md", "snippet two", 0.7)],
      [makeResult("c/three.md", "snippet three", 0.8)],
    ]);
    const result = await verifyQuestions(FAKE_EMBEDDER, db, ["question one", "question two"], 3);
    expect(result.index).toBe("ok");
    expect(result.results).toHaveLength(2);
    expect(result.results[0].question).toBe("question one");
    expect(result.results[0].hits[0]).toEqual({
      path: "a/one.md",
      heading: "Intro",
      lines: [1, 5],
      snippet: "snippet one",
      score: 0.9,
    });
    expect(result.results[1].hits).toHaveLength(1);
    expect(db.lastTopK).toBe(3);
  });

  it("reports index ok with empty hits when nothing matches", async () => {
    const sections: SectionKeyRow[] = [{ node_key: "a/one.md::Intro", file_id: "a/one.md", heading_path: "Intro", heading_text: "Intro" }];
    const db = new StubHybridDb(sections, [[]]);
    const result = await verifyQuestions(FAKE_EMBEDDER, db, ["question"], 2);
    expect(result.index).toBe("ok");
    expect(result.results[0].hits).toEqual([]);
    expect(db.lastTopK).toBe(2);
  });
});
