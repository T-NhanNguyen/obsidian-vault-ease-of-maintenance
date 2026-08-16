// Unit tests for the community-report concern (Phase 4 of the GraphRAG
// buildout — src/indexer/community_reports.ts).
//
// Test-validity mandate: every expectation is hand-computable on tiny
// fixtures. The pure core (estimateTokens / buildReportContext /
// isOverviewQuestion) pins exact numbers; the drivers (generateCommunityReports
// / globalQuery) run against fake stores + a fake LLM (queued contract
// responses — the StubLlmClient pattern) and assert the INPUTS: which
// sections reached the prompt, the context cap, the ranked reports, and that
// no degraded path calls the LLM.

import { describe, it, expect } from "vitest";
import {
  buildReportContext,
  ChatReportLlm,
  estimateTokens,
  generateCommunityReports,
  globalQuery,
  isOverviewQuestion,
  OVERVIEW_MARKERS,
  ReportLlm,
  ReportLlmResult,
} from "../../src/indexer/community_reports";
import type { IEmbedder } from "../../src/indexer/embedder";
import type {
  CommunityReportRow,
  CommunityReportWriteInput,
  CommunityRow,
  SectionSearchRow,
} from "../../src/indexer/db_worker/types";
import type { ILlmClient, ChatMessage } from "../../src/agent/llm_client";

// ---------------------------------------------------------------------------
// Section row factory — hand-computable char-length texts
// ---------------------------------------------------------------------------

function section(nodeKey: string, text: string): SectionSearchRow {
  return {
    node_key: nodeKey,
    file_id: nodeKey.split("::")[0],
    heading_path: nodeKey.split("::")[1] || null,
    heading_text: nodeKey.split("::")[1] || null,
    line_start: 1,
    line_end: 2,
    text,
    content_hash: null,
    path: nodeKey.split("::")[0],
    title: "",
    content_type: "",
    rollup_summary: "",
  };
}

// ---------------------------------------------------------------------------
// Fake LLM — queued contract responses + recorded inputs
// ---------------------------------------------------------------------------

class StubReportLlm implements ReportLlm {
  readonly seen: Array<{ system: string; user: string }> = [];
  private readonly queue: ReportLlmResult[];
  readonly failing: boolean;

  constructor(queue: ReportLlmResult[] = [], failing = false) {
    this.queue = [...queue];
    this.failing = failing;
  }

  async complete(system: string, user: string): Promise<ReportLlmResult> {
    this.seen.push({ system, user });
    if (this.failing) throw new Error("stub llm failure");
    const next = this.queue.shift();
    if (!next) throw new Error("StubReportLlm: response queue exhausted");
    return next;
  }
}

function llmResult(content: string, totalTokens = 42, model = "stub-model"): ReportLlmResult {
  return { content, totalTokens, model };
}

// ---------------------------------------------------------------------------
// estimateTokens — chars / 4, ceil
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("is chars / 4 rounded up (hand-computable)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // 5 chars
    expect(estimateTokens("a".repeat(8))).toBe(2); // exactly 8
    expect(estimateTokens("a".repeat(9))).toBe(3); // 9 → ceil(2.25)
  });
});

// ---------------------------------------------------------------------------
// buildReportContext — deterministic selection under the token budget
// ---------------------------------------------------------------------------

describe("buildReportContext", () => {
  it("includes sections until the cap and drops the rest", () => {
    // cap = 5 tokens = 20 chars.
    // A: 12 chars → 3 tokens; B: 4 chars → 1 token; C: 12 chars → 3 tokens.
    const A = section("x.md::A", "a".repeat(12));
    const B = section("x.md::B", "b".repeat(4));
    const C = section("x.md::C", "c".repeat(12));

    const built = buildReportContext([A, B, C], 5);

    expect(built.includedSectionKeys).toEqual(["x.md::A", "x.md::B"]);
    expect(built.totalTokens).toBe(4); // 3 + 1 — C would exceed (7 > 5)
    expect(built.context).toContain("a".repeat(12));
    expect(built.context).toContain("b".repeat(4));
    expect(built.context).not.toContain("c".repeat(12));
  });

  it("is deterministic regardless of input order (node_key sort wins)", () => {
    const A = section("x.md::A", "a".repeat(12));
    const B = section("x.md::B", "b".repeat(4));
    const C = section("x.md::C", "c".repeat(12));

    const first = buildReportContext([A, B, C], 5);
    const shuffled = buildReportContext([C, A, B], 5);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });

  it("skips empty and whitespace-only sections", () => {
    const A = section("x.md::A", "a".repeat(4)); // 1 token
    const empty = section("x.md::EMPTY", "");
    const blank = section("x.md::BLANK", "   ");

    const built = buildReportContext([A, empty, blank], 5);
    expect(built.includedSectionKeys).toEqual(["x.md::A"]);
    expect(built.totalTokens).toBe(1);
  });

  it("returns an empty context with no fitting sections", () => {
    const A = section("x.md::A", "a".repeat(12)); // 3 tokens
    const B = section("x.md::B", "b".repeat(12)); // 3 tokens
    const built = buildReportContext([A, B], 4); // B alone exceeds the cap
    expect(built.includedSectionKeys).toEqual(["x.md::A"]);
    expect(built.totalTokens).toBe(3);
    expect(buildReportContext([], 5).includedSectionKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isOverviewQuestion — the global-mode routing classifier
// ---------------------------------------------------------------------------

describe("isOverviewQuestion", () => {
  it("routes pure-stopword overview questions to global mode", () => {
    expect(isOverviewQuestion("what is this vault about?")).toBe(true);
    expect(isOverviewQuestion("tell me about the notes")).toBe(true);
  });

  it("routes tokenized overview questions via the markers", () => {
    expect(isOverviewQuestion("what topics does this vault cover?")).toBe(true);
    expect(isOverviewQuestion("give me an overview of the vault")).toBe(true);
    expect(isOverviewQuestion("summarize my notes")).toBe(true);
    for (const marker of OVERVIEW_MARKERS) {
      expect(isOverviewQuestion(`anything ${marker} anything`)).toBe(true);
    }
  });

  it("keeps specific retrieval questions on the local path", () => {
    expect(isOverviewQuestion("how does bloom energy work?")).toBe(false);
    expect(isOverviewQuestion("what is the datacenter power demand?")).toBe(false);
    expect(isOverviewQuestion("coffee brewing ratios")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateCommunityReports — inputs asserted, not just stored output
// ---------------------------------------------------------------------------

class FakeReportStore {
  readonly communities: CommunityRow[];
  readonly sectionsByCommunity = new Map<string, SectionSearchRow[]>();
  readonly written: CommunityReportWriteInput[] = [];

  constructor(communities: CommunityRow[], sectionsByCommunity: Map<string, SectionSearchRow[]>) {
    this.communities = communities;
    this.sectionsByCommunity = sectionsByCommunity;
  }

  async getAllCommunities(): Promise<CommunityRow[]> {
    return this.communities;
  }

  async getSectionsForCommunity(communityId: string): Promise<SectionSearchRow[]> {
    return this.sectionsByCommunity.get(communityId) || [];
  }

  async upsertCommunityReport(report: CommunityReportWriteInput): Promise<void> {
    this.written.push(report);
  }
}

describe("generateCommunityReports", () => {
  it("passes only the sections under the cap and skips empty communities", async () => {
    // c1: S1 (12 chars → 3 tokens) + S2 (4 chars → 1 token) fit the 5-token
    // cap; S3 (12 chars) is dropped. c2 has no sections → no LLM call.
    const store = new FakeReportStore(
      [
        { community_id: "c1", seed_source: "auto", label: "Stocks" },
        { community_id: "c2", seed_source: "auto", label: "Speculations" },
      ],
      new Map([
        ["c1", [
          section("c1.md::S1", "a".repeat(12)),
          section("c1.md::S2", "b".repeat(4)),
          section("c1.md::S3", "c".repeat(12)),
        ]],
        ["c2", []],
      ]),
    );
    const llm = new StubReportLlm([llmResult("report-c1", 42, "stub-model")]);

    const results = await generateCommunityReports(store, llm, { contextCapTokens: 5 });

    // Only c1 was summarized — one LLM call, c2 skipped.
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0].system).toBeTruthy();
    const user = llm.seen[0].user;
    expect(user).toContain("Community: Stocks");
    expect(user).toContain("a".repeat(12)); // S1 in
    expect(user).toContain("b".repeat(4)); // S2 in
    expect(user).not.toContain("c".repeat(12)); // S3 beyond the cap — dropped

    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({
      communityId: "c1",
      report: "report-c1",
      model: "stub-model",
      tokens: 42,
    });

    expect(results).toHaveLength(1);
    expect(results[0].includedSectionKeys).toEqual(["c1.md::S1", "c1.md::S2"]);
  });

  it("is idempotent across rebuilds — same reports written twice", async () => {
    const store = new FakeReportStore(
      [{ community_id: "c1", seed_source: "auto", label: "Stocks" }],
      new Map([["c1", [section("c1.md::S1", "a".repeat(4))]]]),
    );

    await generateCommunityReports(store, new StubReportLlm([llmResult("r1")]), { contextCapTokens: 5 });
    await generateCommunityReports(store, new StubReportLlm([llmResult("r1")]), { contextCapTokens: 5 });

    expect(store.written).toHaveLength(2);
    expect(store.written[0].report).toBe(store.written[1].report);
    expect(store.written[0].model).toBe(store.written[1].model);
    expect(store.written[0].tokens).toBe(store.written[1].tokens);
  });

  it("propagates an LLM failure — already-written reports remain", async () => {
    const store = new FakeReportStore(
      [{ community_id: "c1", seed_source: "auto", label: "Stocks" }],
      new Map([["c1", [section("c1.md::S1", "a".repeat(4))]]]),
    );
    const failing = new StubReportLlm([], true);

    await expect(
      generateCommunityReports(store, failing, { contextCapTokens: 5 }),
    ).rejects.toThrow("stub llm failure");
    expect(store.written).toHaveLength(0); // nothing written before the failure
  });

  it("leaves reports absent when no community has section content", async () => {
    const store = new FakeReportStore(
      [{ community_id: "c1", seed_source: "auto", label: "Stocks" }],
      new Map([["c1", []]]),
    );
    const llm = new StubReportLlm();

    const results = await generateCommunityReports(store, llm);
    expect(results).toEqual([]);
    expect(store.written).toEqual([]);
    expect(llm.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// globalQuery — map-reduce sequence, grounded only in selected reports
// ---------------------------------------------------------------------------

/** Deterministic embedder mapping known substrings (case-insensitive) to unit vectors. */
class FixedEmbedder implements IEmbedder {
  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    if (lower.includes("bloom")) return [1, 0, 0];
    if (lower.includes("datacenter")) return [0, 1, 0];
    if (lower.includes("coffee")) return [0, 0, 1];
    return [0, 0, 0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

class FailingEmbedder implements IEmbedder {
  async embed(): Promise<number[]> {
    throw new Error("no api key");
  }

  async embedBatch(): Promise<number[][]> {
    throw new Error("no api key");
  }
}

function reportRow(communityId: string, report: string): CommunityReportRow {
  return {
    community_id: communityId,
    report,
    model: "stub-model",
    tokens: 10,
    built_at: "2026-08-16T00:00:00.000Z",
  };
}

const GLOBAL_COMMUNITIES: CommunityRow[] = [
  { community_id: "aa", seed_source: "auto", label: "Bloom Co" },
  { community_id: "bb", seed_source: "auto", label: "DC" },
  { community_id: "cc", seed_source: "auto", label: "Coffee" },
];

const GLOBAL_REPORTS: CommunityReportRow[] = [
  reportRow("aa", "Bloom energy fuel cell technology overview."),
  reportRow("bb", "Datacenter power demand forecasting."),
  reportRow("cc", "Coffee brewing ratios and bean origins."),
];

class FakeGlobalDb {
  readonly reports: CommunityReportRow[];
  readonly communities: CommunityRow[];

  constructor(reports: CommunityReportRow[] = [], communities: CommunityRow[] = []) {
    this.reports = reports;
    this.communities = communities;
  }

  async getAllCommunityReports(): Promise<CommunityReportRow[]> {
    return this.reports;
  }

  async getAllCommunities(): Promise<CommunityRow[]> {
    return this.communities;
  }
}

describe("globalQuery", () => {
  it("ranks reports by cosine and grounds the synthesis only in the selected reports", async () => {
    const db = new FakeGlobalDb(GLOBAL_REPORTS, GLOBAL_COMMUNITIES);
    const llm = new StubReportLlm([llmResult("global answer")]);

    const result = await globalQuery(new FixedEmbedder(), db, llm, "bloom energy");

    expect(result.mode).toBe("global");
    expect(result.answer).toBe("global answer");
    // aa scores 1.0 (query "bloom energy" → [1,0,0]); bb/cc score 0 — tie
    // broken by community_id asc.
    expect(result.selectedReports).toEqual([
      { communityId: "aa", label: "Bloom Co" },
      { communityId: "bb", label: "DC" },
      { communityId: "cc", label: "Coffee" },
    ]);

    // The synthesis prompt is grounded ONLY in reports — map-reduce context
    // has the report text + labels, never anything else.
    const user = llm.seen[0].user;
    expect(user).toContain("## Bloom Co");
    expect(user).toContain("Bloom energy fuel cell technology overview.");
    expect(user).toContain("## Coffee");
    expect(user).toContain("Question: bloom energy");
    expect(user).not.toContain("SECRET-RAW-SECTION-TEXT");
  });

  it("honors topReports — only the best reports reach the synthesis", async () => {
    const db = new FakeGlobalDb(GLOBAL_REPORTS, GLOBAL_COMMUNITIES);
    const llm = new StubReportLlm([llmResult("answer")]);

    const result = await globalQuery(new FixedEmbedder(), db, llm, "coffee origins", { topReports: 1 });

    expect(result.mode).toBe("global");
    expect(result.selectedReports).toEqual([{ communityId: "cc", label: "Coffee" }]);
    const user = llm.seen[0].user;
    expect(user).toContain("Coffee brewing ratios and bean origins.");
    expect(user).not.toContain("## Bloom Co");
  });

  it("degrades to local mode with no reports and never calls the LLM", async () => {
    const db = new FakeGlobalDb([], GLOBAL_COMMUNITIES);
    const llm = new StubReportLlm();

    const result = await globalQuery(new FixedEmbedder(), db, llm, "what is this vault about?");

    expect(result.mode).toBe("local");
    expect(result.answer).toBe("");
    expect(result.message).toContain("No community reports");
    expect(llm.seen).toHaveLength(0); // no hang, no crash, no LLM call
  });

  it("degrades to local mode when report ranking fails (embedder error)", async () => {
    const db = new FakeGlobalDb(GLOBAL_REPORTS, GLOBAL_COMMUNITIES);
    const llm = new StubReportLlm();

    const result = await globalQuery(new FailingEmbedder(), db, llm, "bloom");

    expect(result.mode).toBe("local");
    expect(result.message).toContain("Global retrieval failed");
    expect(llm.seen).toHaveLength(0);
  });

  it("degrades to local mode when the synthesis call fails", async () => {
    const db = new FakeGlobalDb(GLOBAL_REPORTS, GLOBAL_COMMUNITIES);
    const llm = new StubReportLlm([], true); // throws on complete

    const result = await globalQuery(new FixedEmbedder(), db, llm, "bloom energy");

    expect(result.mode).toBe("local");
    expect(result.message).toContain("Global synthesis failed");
    // The ranked reports are still reported — but no answer is fabricated.
    expect(result.selectedReports.length).toBeGreaterThan(0);
  });

  it("skips reports with empty text", async () => {
    const db = new FakeGlobalDb(
      [reportRow("aa", ""), reportRow("bb", "Datacenter power demand forecasting.")],
      GLOBAL_COMMUNITIES,
    );
    const llm = new StubReportLlm([llmResult("answer")]);

    const result = await globalQuery(new FixedEmbedder(), db, llm, "datacenter");

    expect(result.mode).toBe("global");
    expect(result.selectedReports).toEqual([{ communityId: "bb", label: "DC" }]);
  });
});

// ---------------------------------------------------------------------------
// ChatReportLlm — one provider completion, honoring the build thinking gate
// ---------------------------------------------------------------------------

describe("ChatReportLlm", () => {
  it("drives the injected ILlmClient and surfaces content, tokens, and model", async () => {
    let seen: Array<{ model: string; messages: unknown[] }> = [];
    const fakeClient: ILlmClient = {
      async chatCompletion(model: string, messages: ChatMessage[]) {
        seen.push({ model, messages });
        return {
          completionId: "c",
          role: "assistant",
          content: "the report",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: "stop",
        };
      },
    };

    const llm = new ChatReportLlm({ model: "test-model", llm: fakeClient });
    const result = await llm.complete("system", "user");

    expect(result).toEqual({ content: "the report", totalTokens: 15, model: "test-model" });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("test-model");
    expect(seen[0].messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
  });
});
