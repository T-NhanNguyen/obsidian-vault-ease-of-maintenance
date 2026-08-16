// Unit tests for the LLM entity-extraction concern (Phase 5 of the GraphRAG
// buildout — src/indexer/entity_extraction.ts).
//
// Test-validity mandate: every expectation is hand-computable on tiny
// fixtures. The pure core (parseExtractionResponse / mentionsInSections /
// semanticEdgesForRelations / buildExtractionBatches / groupSectionsByFile /
// the normalizers) pins exact values; the drivers (generateSemanticGraph /
// storeExtraction) run against a fake store + a fake LLM (queued contract
// responses) and assert the INPUTS (which files/sections reached the prompt,
// what was written) — never the real network.

import { describe, it, expect } from "vitest";
import {
  buildExtractionBatches,
  DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractableFile,
  ExtractableSection,
  generateSemanticGraph,
  groupSectionsByFile,
  mentionsInSections,
  normalizeEntityType,
  normalizeRelationKind,
  parseExtractionResponse,
  semanticEdgesForRelations,
  storeExtraction,
} from "../../src/indexer/entity_extraction";
import { entityId } from "../../src/indexer/graph";
import type { ReportLlm, ReportLlmResult } from "../../src/indexer/community_reports";
import type { Edge, EntityWriteInput, SectionEntityInput } from "../../src/indexer/db_worker/types";

// ---------------------------------------------------------------------------
// Section factory — hand-computable char-length texts
// ---------------------------------------------------------------------------

function section(nodeKey: string, text: string, headingPath: string | null = null): ExtractableSection {
  return { node_key: nodeKey, text, heading_path: headingPath };
}

function file(fileId: string, sections: ExtractableSection[]): ExtractableFile {
  return { fileId, sections };
}

// ---------------------------------------------------------------------------
// Fake LLM + store — queued contract responses + recorded inputs
// ---------------------------------------------------------------------------

class StubExtractionLlm implements ReportLlm {
  readonly seen: Array<{ system: string; user: string }> = [];
  private readonly queue: ReportLlmResult[];
  readonly failing: boolean;

  constructor(queue: ReportLlmResult[] = [], failing = false) {
    this.queue = [...queue];
    this.failing = failing;
  }

  async complete(system: string, user: string): Promise<ReportLlmResult> {
    this.seen.push({ system, user });
    if (this.failing) throw new Error("stub extraction failure");
    const next = this.queue.shift();
    if (!next) throw new Error("StubExtractionLlm: response queue exhausted");
    return next;
  }
}

class FakeExtractionStore {
  readonly entities: EntityWriteInput[] = [];
  readonly sectionMentions: Array<{ sectionKey: string; entities: SectionEntityInput[] }> = [];
  readonly edges: Edge[] = [];

  async insertEntities(entities: EntityWriteInput[]): Promise<void> {
    this.entities.push(...entities);
  }

  async insertSectionEntities(sectionKey: string, entities: SectionEntityInput[]): Promise<void> {
    this.sectionMentions.push({ sectionKey, entities });
  }

  async insertEdges(edges: Edge[]): Promise<void> {
    this.edges.push(...edges);
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

describe("normalizeEntityType", () => {
  it("lowercases and maps non-alphanumerics to underscores", () => {
    expect(normalizeEntityType("Organization")).toBe("organization");
    expect(normalizeEntityType("data-center Operator")).toBe("data_center_operator");
    expect(normalizeEntityType("!!")).toBe("concept"); // empty → concept
    expect(normalizeEntityType("")).toBe("concept");
  });
});

describe("normalizeRelationKind", () => {
  it("produces a 'semantic:' kind that flows through traversal", () => {
    expect(normalizeRelationKind("part_of")).toBe("semantic:part_of");
    expect(normalizeRelationKind("Depends On")).toBe("semantic:depends_on");
    expect(normalizeRelationKind("")).toBe("semantic:related_to");
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse
// ---------------------------------------------------------------------------

describe("parseExtractionResponse", () => {
  it("parses ENTITY/REL lines, dedupes, and sorts deterministically", () => {
    const extraction = parseExtractionResponse(
      [
        "ENTITY|Bloom Energy|organization",
        "ENTITY|Bloom Energy|company", // duplicate name — first wins
        "ENTITY|Fuel Cell Stack|technology",
        "ENTITY|Short|person",
        "REL|Bloom Energy|Fuel Cell Stack|produces",
        "REL|Fuel Cell Stack|Bloom Energy|depends_on",
        "REL|Bloom Energy|Bloom Energy|part_of", // self-reference — dropped
        "REL|Bloom Energy|Fuel Cell Stack|produces", // duplicate — dropped
        "not a valid line", // junk — skipped
        "ENTITY|", // empty name — skipped
        "REL|A||part_of", // empty dst — skipped
      ].join("\n"),
    );

    expect(extraction.entities).toEqual([
      { name: "Bloom Energy", type: "organization" },
      { name: "Fuel Cell Stack", type: "technology" },
      { name: "Short", type: "person" },
    ]);
    expect(extraction.relations).toEqual([
      { src: "Bloom Energy", dst: "Fuel Cell Stack", relation: "produces" },
      { src: "Fuel Cell Stack", dst: "Bloom Energy", relation: "depends_on" },
    ]);
  });

  it("caps entities and relations after the deterministic sort", () => {
    const extraction = parseExtractionResponse(
      [
        "ENTITY|Bloom Energy|organization",
        "ENTITY|Fuel Cell Stack|technology",
        "ENTITY|Short|person",
        "REL|A|B|produces",
        "REL|C|D|related_to",
      ].join("\n"),
      { maxEntities: 2, maxRelations: 1 },
    );
    expect(extraction.entities.map((e) => e.name)).toEqual(["Bloom Energy", "Fuel Cell Stack"]);
    expect(extraction.relations).toEqual([{ src: "A", dst: "B", relation: "produces" }]);
  });

  it("returns empty structures for empty input", () => {
    expect(parseExtractionResponse("")).toEqual({ entities: [], relations: [] });
    expect(parseExtractionResponse("   \n# markdown noise\n")).toEqual({
      entities: [],
      relations: [],
    });
  });
});

// ---------------------------------------------------------------------------
// mentionsInSections
// ---------------------------------------------------------------------------

const MENTION_SECTIONS: ExtractableSection[] = [
  section("a.md::Bloom Energy", "Bloom fuel cells.", "Bloom Energy"),
  section("a.md::Bloom Energy › Fuel Cell Stack", "Efficiency above 60 percent.", "Bloom Energy › Fuel Cell Stack"),
  section("b.md::Datacenter Power", "AI data centers consume power.", "Datacenter Power"),
  section("c.md::Coffee Notes", "Cold brew ratios and bean origins.", "Coffee Notes"),
];

describe("mentionsInSections", () => {
  it("matches the entity name verbatim against heading + body, case-insensitively", () => {
    expect(mentionsInSections("Bloom Energy", MENTION_SECTIONS)).toEqual([
      "a.md::Bloom Energy",
      "a.md::Bloom Energy › Fuel Cell Stack", // matched via the heading haystack
    ]);
    expect(mentionsInSections("cold brew", MENTION_SECTIONS)).toEqual(["c.md::Coffee Notes"]);
    expect(mentionsInSections("datacenter power", MENTION_SECTIONS)).toEqual(["b.md::Datacenter Power"]);
  });

  it("drops short names (noise guard) and no-match names", () => {
    expect(mentionsInSections("AI", MENTION_SECTIONS)).toEqual([]); // 2 chars
    expect(mentionsInSections("bloom", MENTION_SECTIONS)).toEqual([
      "a.md::Bloom Energy",
      "a.md::Bloom Energy › Fuel Cell Stack", // "bloom" is in both heading haystacks
    ]);
    expect(mentionsInSections("nonexistent concept", MENTION_SECTIONS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// semanticEdgesForRelations
// ---------------------------------------------------------------------------

describe("semanticEdgesForRelations", () => {
  const MENTIONS = new Map<string, string[]>([
    ["Bloom Energy", ["a.md::Bloom Energy", "a.md::Bloom Energy › Fuel Cell Stack"]],
    ["Fuel Cell Stack", ["a.md::Bloom Energy › Fuel Cell Stack"]],
    ["Datacenter Power", ["b.md::Datacenter Power"]],
  ]);

  it("emits the mention cross-product with the relation kind, skipping self-edges", () => {
    const edges = semanticEdgesForRelations(
      [
        { src: "Bloom Energy", dst: "Fuel Cell Stack", relation: "produces" },
        { src: "Bloom Energy", dst: "Datacenter Power", relation: "related_to" },
      ],
      MENTIONS,
    );
    expect(edges).toEqual([
      { srcKey: "a.md::Bloom Energy", dstKey: "a.md::Bloom Energy › Fuel Cell Stack", kind: "semantic:produces", weight: 1 },
      { srcKey: "a.md::Bloom Energy", dstKey: "b.md::Datacenter Power", kind: "semantic:related_to", weight: 1 },
      { srcKey: "a.md::Bloom Energy › Fuel Cell Stack", dstKey: "b.md::Datacenter Power", kind: "semantic:related_to", weight: 1 },
    ]);
  });

  it("caps edges per relationship deterministically", () => {
    const edges = semanticEdgesForRelations(
      [{ src: "Bloom Energy", dst: "Datacenter Power", relation: "related_to" }],
      MENTIONS,
      1,
    );
    expect(edges).toEqual([
      { srcKey: "a.md::Bloom Energy", dstKey: "b.md::Datacenter Power", kind: "semantic:related_to", weight: 1 },
    ]);
  });

  it("emits nothing for relationships whose entities have no mentions", () => {
    expect(
      semanticEdgesForRelations(
        [{ src: "Ghost", dst: "Bloom Energy", relation: "part_of" }],
        MENTIONS,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupSectionsByFile
// ---------------------------------------------------------------------------

describe("groupSectionsByFile", () => {
  it("groups by file id and sorts files deterministically", () => {
    const grouped = groupSectionsByFile([
      { nodeKey: "b.md::B", fileId: "b.md", text: "b", headingPath: "B" },
      { nodeKey: "a.md::A", fileId: "a.md", text: "a", headingPath: "A" },
      { nodeKey: "a.md::A2", fileId: "a.md", text: "a2", headingPath: "A2" },
    ]);
    expect(grouped).toEqual([
      file("a.md", [
        section("a.md::A", "a", "A"),
        section("a.md::A2", "a2", "A2"),
      ]),
      file("b.md", [section("b.md::B", "b", "B")]),
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildExtractionBatches
// ---------------------------------------------------------------------------

describe("buildExtractionBatches", () => {
  const A12 = section("a.md::A", "a".repeat(12), "A"); // 12 chars → 3 tokens
  const B4 = section("a.md::B", "b".repeat(4), "B"); // 4 chars → 1 token
  const C12 = section("b.md::C", "c".repeat(12), "C"); // 3 tokens

  it("packs files greedily under the cap and overflows into new batches", () => {
    // a.md = 4 tokens; b.md = 3 tokens. cap 5 → two batches; cap 7 → one.
    const batches = buildExtractionBatches([file("b.md", [C12]), file("a.md", [A12, B4])], 5);

    expect(batches).toHaveLength(2);
    expect(batches[0].fileIds).toEqual(["a.md"]);
    expect(batches[0].sections.map((s) => s.node_key)).toEqual(["a.md::A", "a.md::B"]);
    expect(batches[0].totalTokens).toBe(4);
    expect(batches[1].fileIds).toEqual(["b.md"]);
    expect(batches[1].sections.map((s) => s.node_key)).toEqual(["b.md::C"]);
    expect(batches[1].totalTokens).toBe(3);

    const single = buildExtractionBatches([file("b.md", [C12]), file("a.md", [A12, B4])], 7);
    expect(single).toHaveLength(1);
    expect(single[0].fileIds).toEqual(["a.md", "b.md"]); // file-id order, not input order
    expect(single[0].totalTokens).toBe(7);
  });

  it("applies the per-file cap (drop-beyond) before batching", () => {
    // cap 5: A(3) + B(1) = 4; C(3) would exceed → dropped from a.md's context.
    const batches = buildExtractionBatches([file("a.md", [A12, B4, C12])], 5);
    expect(batches).toHaveLength(1);
    expect(batches[0].sections.map((s) => s.node_key)).toEqual(["a.md::A", "a.md::B"]);
    expect(batches[0].totalTokens).toBe(4);
  });

  it("skips files with no fitting sections", () => {
    const empty = file("a.md", [section("a.md::E", "")]);
    expect(buildExtractionBatches([empty], 5)).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const one = buildExtractionBatches([file("a.md", [A12, B4]), file("b.md", [C12])], 5);
    const two = buildExtractionBatches([file("b.md", [C12]), file("a.md", [A12, B4])], 5);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

// ---------------------------------------------------------------------------
// storeExtraction
// ---------------------------------------------------------------------------

describe("storeExtraction", () => {
  it("stores grounded entities as llm:<type>, mentions, and semantic edges", async () => {
    const store = new FakeExtractionStore();
    const sections = [
      section("a.md::Bloom Energy", "Bloom fuel cells.", "Bloom Energy"),
      section("a.md::Fuel Cell Stack", "Efficiency detail.", "Fuel Cell Stack"),
    ];
    const extraction = {
      entities: [
        { name: "Bloom Energy", type: "Organization" },
        { name: "Ghost", type: "concept" }, // not in the text — dropped
      ],
      // "Fuel Cell Stack" is referenced WITHOUT an ENTITY line (small-model
      // behavior) — the edge is still grounded via verbatim mention matching.
      relations: [{ src: "Bloom Energy", dst: "Fuel Cell Stack", relation: "produces" }],
    };

    await storeExtraction(store, sections, extraction);

    expect(store.entities).toEqual([
      { entityId: entityId("Bloom Energy"), name: "Bloom Energy", type: "llm:organization" },
    ]);
    expect(store.sectionMentions).toEqual([
      { sectionKey: "a.md::Bloom Energy", entities: [{ entityId: entityId("Bloom Energy") }] },
    ]);
    expect(store.edges).toEqual([
      { srcKey: "a.md::Bloom Energy", dstKey: "a.md::Fuel Cell Stack", kind: "semantic:produces", weight: 1 },
    ]);
  });

  it("writes nothing when no entity is grounded", async () => {
    const store = new FakeExtractionStore();
    await storeExtraction(store, [section("a.md::A", "text", "A")], {
      entities: [{ name: "Ungrounded", type: "concept" }],
      relations: [],
    });
    expect(store.entities).toEqual([]);
    expect(store.sectionMentions).toEqual([]);
    expect(store.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateSemanticGraph — one call per batch, inputs asserted
// ---------------------------------------------------------------------------

describe("generateSemanticGraph", () => {
  it("makes one LLM call per batch and stores the extraction", async () => {
    const store = new FakeExtractionStore();
    const llm = new StubExtractionLlm([
      {
        content: [
          "ENTITY|Bloom Energy|organization",
          "ENTITY|Fuel Cell Stack|technology",
          "REL|Bloom Energy|Fuel Cell Stack|produces",
        ].join("\n"),
        totalTokens: 12,
        model: "stub-model",
      },
    ]);
    const files = [
      file("a.md", [section("a.md::Bloom Energy", "Bloom fuel cells.", "Bloom Energy")]),
      file("b.md", [section("b.md::Fuel Cell Stack", "Stack efficiency.", "Fuel Cell Stack")]),
    ];

    const results = await generateSemanticGraph(store, llm, files, {
      contextCapTokens: DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS,
    });

    expect(llm.seen).toHaveLength(1); // both files fit one batch
    expect(llm.seen[0].system).toBe(EXTRACTION_SYSTEM_PROMPT);
    const user = llm.seen[0].user;
    expect(user).toContain("File: a.md");
    expect(user).toContain("File: b.md");
    expect(user).toContain("Bloom fuel cells.");

    expect(results).toEqual([{ fileIds: ["a.md", "b.md"], entities: 2, relations: 1 }]);
    // The relation produced exactly one edge: Bloom Energy → Fuel Cell Stack.
    expect(store.edges).toHaveLength(1);
    expect(store.edges[0].kind).toBe("semantic:produces");
    expect(store.entities.map((e) => e.name).sort()).toEqual(["Bloom Energy", "Fuel Cell Stack"]);
  });

  it("makes one call per batch when files overflow the cap", async () => {
    const store = new FakeExtractionStore();
    const llm = new StubExtractionLlm([
      { content: "ENTITY|A Thing|concept", totalTokens: 5, model: "stub-model" },
      { content: "ENTITY|B Thing|concept", totalTokens: 5, model: "stub-model" },
    ]);
    const files = [
      file("a.md", [section("a.md::A", "a".repeat(12), "A")]), // 3 tokens
      file("b.md", [section("b.md::B", "b".repeat(12), "B")]), // 3 tokens
    ];

    await generateSemanticGraph(store, llm, files, { contextCapTokens: 5 });

    expect(llm.seen).toHaveLength(2); // 3 + 3 > 5 → two batches
    expect(llm.seen[0].user).toContain("File: a.md");
    expect(llm.seen[1].user).toContain("File: b.md");
  });

  it("propagates an LLM failure (the caller catches and warns)", async () => {
    const store = new FakeExtractionStore();
    const failing = new StubExtractionLlm([], true);
    await expect(
      generateSemanticGraph(store, failing, [file("a.md", [section("a.md::A", "text", "A")])]),
    ).rejects.toThrow("stub extraction failure");
    expect(store.entities).toEqual([]);
  });

  it("makes no LLM call when every file is below the mention/context floor", async () => {
    const store = new FakeExtractionStore();
    const llm = new StubExtractionLlm();
    const files = [file("a.md", [section("a.md::E", "", "E")])]; // empty text → skipped
    const results = await generateSemanticGraph(store, llm, files);
    expect(llm.seen).toHaveLength(0);
    expect(results).toEqual([]);
  });
});
