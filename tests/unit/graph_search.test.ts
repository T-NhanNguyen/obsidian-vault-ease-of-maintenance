// Unit tests for the hybrid local-search pure functions (Phase 1 of the
// GraphRAG buildout — .dev-vault/handoff.md).
//
// Test-validity mandate: every expectation below is hand-computable on tiny
// fixtures — no golden files, no "runs without error" smoke tests. The pure
// functions (resolveQueryNodes / expandNeighbors / hybridRank) take plain
// inputs and return deterministic values.

import { describe, it, expect } from "vitest";
import {
  resolveQueryNodes,
  expandNeighbors,
  hybridRank,
  significantTokens,
} from "../../src/indexer/graph_search";
import type {
  EdgeRow,
  EntityRow,
  SearchResult,
  SectionEntityRow,
  SectionKeyRow,
} from "../../src/indexer/db_worker/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECTIONS: SectionKeyRow[] = [
  {
    node_key: "notes/a.md::Bloom Energy",
    file_id: "notes/a.md",
    heading_path: "Bloom Energy",
    heading_text: "Bloom Energy",
  },
  {
    node_key: "notes/a.md::Bloom Energy › Fuel Cell Stack",
    file_id: "notes/a.md",
    heading_path: "Bloom Energy › Fuel Cell Stack",
    heading_text: "Fuel Cell Stack",
  },
  {
    node_key: "notes/b.md::Market Position",
    file_id: "notes/b.md",
    heading_path: "Market Position",
    heading_text: "Market Position",
  },
  {
    node_key: "notes/c.md::",
    file_id: "notes/c.md",
    heading_path: null,
    heading_text: null,
  },
];

const ENTITIES: EntityRow[] = [
  { entity_id: "e1", name: "Bloom Energy" },
  { entity_id: "e2", name: "Fuel" },
  { entity_id: "e3", name: "Datacenter" },
];

const MENTIONS: SectionEntityRow[] = [
  { section_key: "notes/a.md::Bloom Energy", entity_id: "e1" },
  { section_key: "notes/a.md::Bloom Energy › Fuel Cell Stack", entity_id: "e2" },
  { section_key: "notes/b.md::Market Position", entity_id: "e3" },
];

const KEY_BLOOM = "notes/a.md::Bloom Energy";
const KEY_FUEL_STACK = "notes/a.md::Bloom Energy › Fuel Cell Stack";
const KEY_MARKET = "notes/b.md::Market Position";

// ---------------------------------------------------------------------------
// significantTokens
// ---------------------------------------------------------------------------

describe("significantTokens", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and singles", () => {
    expect(significantTokens("Bloom Energy fuel cells!")).toEqual([
      "bloom", "energy", "fuel", "cells",
    ]);
  });

  it("drops vault-filler stopwords", () => {
    expect(significantTokens("what is this vault about")).toEqual([]);
    expect(significantTokens("tell me about the notes")).toEqual([]);
  });

  it("dedupes repeated tokens", () => {
    expect(significantTokens("energy energy energy")).toEqual(["energy"]);
  });
});

// ---------------------------------------------------------------------------
// resolveQueryNodes
// ---------------------------------------------------------------------------

describe("resolveQueryNodes", () => {
  it("scores heading-path token coverage and applies the phrase bonus", () => {
    // tokens = [bloom, energy, fuel, cells]. "Fuel Cell Stack" contains
    // "cell" but not "cells" → 3/4. Sorted by score desc.
    expect(resolveQueryNodes("bloom energy fuel cells", SECTIONS, [], [])).toEqual([
      { nodeKey: KEY_FUEL_STACK, score: 0.75 }, // 3/4 tokens (no "cells")
      { nodeKey: KEY_BLOOM, score: 0.5 },       // 2/4 tokens, no phrase
    ]);
  });

  it("adds the phrase bonus when the full question appears in a heading", () => {
    expect(resolveQueryNodes("market position", SECTIONS, [], [])).toEqual([
      { nodeKey: KEY_MARKET, score: 1.5 }, // 2/2 tokens + 0.5 phrase bonus
    ]);
  });

  it("maps entity-name matches to their mentioning sections", () => {
    // "datacenter" matches no heading, but entity e3 ("Datacenter") is
    // mentioned by KEY_MARKET — the entity tier resolves it.
    expect(resolveQueryNodes("datacenter", SECTIONS, ENTITIES, MENTIONS)).toEqual([
      { nodeKey: KEY_MARKET, score: 1.0 }, // 1/1 entity-name token
    ]);
  });

  it("merges tiers by max score per node", () => {
    // e1 "Bloom Energy" shares 2/2 tokens → candidate 1.0 for KEY_BLOOM;
    // the heading tier already scored it 1.5 (2/2 + phrase), max wins.
    // KEY_FUEL_STACK also scores 1.5 (2/2 tokens + "bloom energy" phrase in
    // its full heading path); tie broken by node_key asc.
    expect(resolveQueryNodes("bloom energy", SECTIONS, ENTITIES, MENTIONS)).toEqual([
      { nodeKey: KEY_BLOOM, score: 1.5 },
      { nodeKey: KEY_FUEL_STACK, score: 1.5 },
    ]);
  });

  it("ignores entities that share no tokens with the question", () => {
    // "Bloom" (entity e1) shares no token with [market, position]; only the
    // heading tier fires.
    expect(resolveQueryNodes("market position", SECTIONS, ENTITIES, MENTIONS)).toEqual([
      { nodeKey: KEY_MARKET, score: 1.5 },
    ]);
  });

  it("returns nothing for a no-match question", () => {
    expect(resolveQueryNodes("the quick brown fox", SECTIONS, [], [])).toEqual([]);
  });

  it("returns nothing for a stopword-only question", () => {
    expect(resolveQueryNodes("what is this about", SECTIONS, [], [])).toEqual([]);
  });

  it("sorts by score desc, then node_key asc, capped at maxSeeds", () => {
    // Fuel Cell Stack scores 0.75 (3/4 tokens), Bloom Energy 0.5 (2/4).
    // maxSeeds=1 keeps only the best.
    expect(resolveQueryNodes("bloom energy fuel cells", SECTIONS, [], [], 1)).toEqual([
      { nodeKey: KEY_FUEL_STACK, score: 0.75 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// expandNeighbors
// ---------------------------------------------------------------------------

const EDGES: EdgeRow[] = [
  { src_key: "A", dst_key: "B", kind: "wikilink", weight: 1.0 },
  { src_key: "A", dst_key: "C", kind: "wikilink", weight: 0.9 },
  { src_key: "B", dst_key: "A", kind: "backlink", weight: 0.8 },
  { src_key: "C", dst_key: "D", kind: "wikilink", weight: 1.0 },
  { src_key: "A", dst_key: "X", kind: "inferred", weight: 0.9 },
  { src_key: "A", dst_key: "Z", kind: "wikilink", weight: 0.5 },
];

describe("expandNeighbors", () => {
  it("expands depth 1 in weight order, excluding inferred edges", () => {
    // From A: B (1.0), C (0.9), Z (0.5); X is inferred and must never
    // appear. Seeds come first, then BFS order.
    expect(expandNeighbors(["A"], EDGES, { depth: 1 })).toEqual(["A", "B", "C", "Z"]);
  });

  it("expands depth 2 without revisiting (cycle-safe)", () => {
    // Level 2 from [B, C, Z]: B's backlink points back to A (visited), C
    // reaches D, Z has no outgoing edges.
    expect(expandNeighbors(["A"], EDGES, { depth: 2 })).toEqual(["A", "B", "C", "Z", "D"]);
  });

  it("caps the fan-out per key", () => {
    expect(expandNeighbors(["A"], EDGES, { depth: 1, maxFanOut: 2 })).toEqual(["A", "B", "C"]);
  });

  it("never follows inferred edges even when they are the only ones", () => {
    const onlyInferred: EdgeRow[] = [
      { src_key: "A", dst_key: "X", kind: "inferred", weight: 0.9 },
    ];
    expect(expandNeighbors(["A"], onlyInferred, { depth: 2 })).toEqual(["A"]);
  });

  it("dedupes seeds and keeps input order", () => {
    expect(expandNeighbors(["A", "A", "B"], EDGES, { depth: 1 })).toEqual(["A", "B", "C", "Z"]);
  });

  it("breaks weight ties by dst_key for determinism", () => {
    const tied: EdgeRow[] = [
      { src_key: "A", dst_key: "N", kind: "wikilink", weight: 0.7 },
      { src_key: "A", dst_key: "M", kind: "wikilink", weight: 0.7 },
    ];
    expect(expandNeighbors(["A"], tied, { depth: 1 })).toEqual(["A", "M", "N"]);
  });
});

// ---------------------------------------------------------------------------
// hybridRank
// ---------------------------------------------------------------------------

function mkResult(nodeKey: string): SearchResult {
  return {
    nodeKey,
    fileId: nodeKey,
    filePath: nodeKey,
    headingPath: "",
    headingText: "",
    lineStart: 0,
    lineEnd: 0,
    text: "",
    contentHash: "",
    fileContentHash: "",
    contentType: "",
    rollupSummary: "",
    title: "",
    score: 0,
  };
}

describe("hybridRank", () => {
  it("keeps cosine hits first, appends graph-only hits below, deduped", () => {
    const cosine = [mkResult("A"), mkResult("B")];
    const graph = [mkResult("B"), mkResult("C"), mkResult("A")];
    expect(hybridRank(cosine, graph).map((r) => r.nodeKey)).toEqual(["A", "B", "C"]);
  });

  it("returns cosine hits unchanged when there are no graph hits", () => {
    const cosine = [mkResult("A"), mkResult("B")];
    expect(hybridRank(cosine, []).map((r) => r.nodeKey)).toEqual(["A", "B"]);
  });

  it("keeps graph hits in their given order when cosine is empty", () => {
    expect(hybridRank([], [mkResult("B"), mkResult("C")]).map((r) => r.nodeKey)).toEqual([
      "B", "C",
    ]);
  });
});
