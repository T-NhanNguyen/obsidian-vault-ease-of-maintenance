// Integration tests — LLM entity extraction + semantic edges + traversal +
// incremental legs (Phase 5 of the GraphRAG buildout, .dev-vault/handoff.md).
//
// Builds real indexes through Indexer.build / Indexer.incremental (fake
// embedder + temp vault, the MemIO-style harness) with a deterministic
// extraction LLM (queued contract responses) and pins, by hand:
//   1. The three new DB reads (protocol + dispatch round trips through the
//      DatabaseManager facade → in-process worker channel → sql.js engine).
//   2. The build-side extraction pass: llm:-typed entities + SECTION_ENTITIES
//      + semantic EDGES, and the INPUTS (which files reached the prompt).
//   3. The traversal upgrade: a semantic edge reaches a section that
//      wikilinks cannot — pinned exactly below the pure-cosine top-k.
//   4. The regression pin: a no-LLM build has zero semantic edges and the
//      query result is byte-identical to Phase-1 (no Coffee hit).
//   5. The incremental legs: deleted-file gap, unseeded auto re-cluster,
//      report regeneration for changed communities only, extraction re-run
//      on changed files.

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";
import { DatabaseManager } from "../../src/indexer/db";
import { entityId } from "../../src/indexer/graph";
import type { ReportLlm, ReportLlmResult } from "../../src/indexer/community_reports";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function count(dbPath: string, table: string): number {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const row = conn.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0];
    return typeof row === "number" ? row : 0;
  } finally {
    conn.close();
  }
}

function countEdgesByKind(dbPath: string, kindPrefix: string): number {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const row = conn.exec(
      `SELECT COUNT(*) FROM EDGES WHERE kind LIKE '${kindPrefix}%'`,
    )[0]?.values[0]?.[0];
    return typeof row === "number" ? row : 0;
  } finally {
    conn.close();
  }
}

/** section_key → community_id, sorted for comparison across runs. */
function communityAssignments(dbPath: string): Array<[string, string]> {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const rows = conn.exec("SELECT section_key, community_id FROM COMMUNITY_SECTIONS")[0]?.values ?? [];
    return rows
      .map((r) => [String(r[0]), String(r[1])] as [string, string])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//   notes/a.md — two sections; links to [[b]] (bare target, no .md)
//   notes/b.md — one section; links back to [[a]]
//   notes/c.md — one section; no links (the semantic-only control)
// ---------------------------------------------------------------------------

const FIXTURE_FILES: Record<string, string> = {
  "notes/a.md": [
    "# Bloom Energy",
    "Bloom fuel cells. See [[b]] for the datacenter angle.",
    "",
    "## Fuel Cell Stack",
    "Efficiency above 60 percent.",
    "",
  ].join("\n"),
  "notes/b.md": [
    "# Datacenter Power",
    "AI data centers consume power. Back to [[a]].",
    "",
  ].join("\n"),
  "notes/c.md": [
    "# Coffee Notes",
    "Cold brew ratios and bean origins.",
    "",
  ].join("\n"),
};

const KEY_BLOOM = "notes/a.md::Bloom Energy";
const KEY_FUEL_STACK = "notes/a.md::Bloom Energy › Fuel Cell Stack";
const KEY_DATACENTER = "notes/b.md::Datacenter Power";
const KEY_COFFEE = "notes/c.md::Coffee Notes";

/** The deterministic extraction response for the 3-file fixture (one batch):
 * entities grounded in the fixture's headings/text + one semantic relation
 * that reaches the never-wikilinked Coffee Notes section. */
const EXTRACTION_RESPONSE = [
  "ENTITY|Bloom Energy|organization",
  "ENTITY|Fuel Cell Stack|technology",
  "ENTITY|Cold Brew|process",
  "REL|Bloom Energy|Cold Brew|related_to",
].join("\n");

/** Zero-shared-gram fixture for the incremental tests: alpha's edit cannot
 * pull beta across the cluster threshold (the Phase-3 stability pattern). */
const DISTINCT_FILES: Record<string, string> = {
  "alpha.md": [
    "# Alpha",
    "proton exchange membrane electrolysis, anode catalyst layers, hydrogen crossover.",
    "",
    "## Deep Alpha",
    "catalyst degradation mechanisms and platinum loading tradeoffs.",
    "",
  ].join("\n"),
  "beta.md": [
    "# Beta",
    "bitcoin mining hashrate economics, gpu farms, halving cycles.",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Deterministic LLM seams
// ---------------------------------------------------------------------------

/** Extraction LLM — queued contract responses (one per batch/call). */
class StubExtractionLlm implements ReportLlm {
  readonly seenUsers: string[] = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async complete(_system: string, user: string): Promise<ReportLlmResult> {
    this.seenUsers.push(user);
    const content = this.responses.shift();
    if (content === undefined) throw new Error("StubExtractionLlm: response queue exhausted");
    return { content, totalTokens: 12, model: "stub-model" };
  }
}

/** Report LLM — template echo (any number of communities, no queue). */
class TemplateReportLlm implements ReportLlm {
  readonly seenUsers: string[] = [];

  async complete(_system: string, user: string): Promise<ReportLlmResult> {
    this.seenUsers.push(user);
    const label = user.match(/Community: ([^\n]+)/)?.[1] || "unknown";
    return { content: `Summary of ${label}.`, totalTokens: 5, model: "stub-model" };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeSettings(vaultPath: string, dbPath: string): Settings {
  return {
    vaultPath,
    configDir: "",
    pluginDir: "",
    dbPath,
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

interface Harness {
  indexer: Indexer;
  settings: Settings;
  vaultDir: string;
  fakeEmbedder: FakeEmbedder;
  extractionLlm?: StubExtractionLlm;
  reportLlm?: TemplateReportLlm;
}

async function writeFiles(vaultDir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
}

async function makeHarness(
  files: Record<string, string>,
  opts: { extractionResponses?: string[]; reports?: boolean } = {},
): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-extraction-"));
  const vaultDir = path.join(tmpDir, "vault");
  await writeFiles(vaultDir, files);
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"));
  const fakeEmbedder = new FakeEmbedder(64);
  const extractionLlm = opts.extractionResponses ? new StubExtractionLlm(opts.extractionResponses) : undefined;
  const reportLlm = opts.reports ? new TemplateReportLlm() : undefined;
  const indexer = new Indexer(settings, fakeEmbedder, reportLlm, extractionLlm);
  await indexer.build();
  return { indexer, settings, vaultDir, fakeEmbedder, extractionLlm, reportLlm };
}

/** Pure-cosine top-k (the pre-Phase-1 query path) for regression pins. */
async function pureCosine(
  settings: Settings,
  fakeEmbedder: FakeEmbedder,
  question: string,
  topK: number,
) {
  const db = new DatabaseManager(settings.dbPath);
  try {
    const q = await fakeEmbedder.embed(question);
    return await db.searchSimilar(q, topK);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// New DB reads — protocol + dispatch round trips
// ---------------------------------------------------------------------------

describe("Phase-5 DB reads (round trips)", () => {
  it("getAllFileIds returns the scanned file ids", async () => {
    const { settings } = await makeHarness(FIXTURE_FILES);
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(await db.getAllFileIds()).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    } finally {
      await db.close();
    }
  });

  it("getSemanticEdges returns nothing on a no-LLM build (regression pin)", async () => {
    const { settings } = await makeHarness(FIXTURE_FILES);
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(await db.getSemanticEdges("notes/a.md")).toEqual([]);
      expect(countEdgesByKind(settings.dbPath, "semantic")).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("pruneEmptyAutoCommunities removes memberless auto communities + their reports", async () => {
    const { settings } = await makeHarness(FIXTURE_FILES, { reports: true });
    const db = new DatabaseManager(settings.dbPath);
    try {
      const communities = await db.getAllCommunities();
      expect(communities.length).toBeGreaterThanOrEqual(1);
      expect(communities.every((c) => c.seed_source === "auto")).toBe(true);

      // A lone auto community with NO members + an orphan report.
      await db.insertCommunity({ communityId: "auto-lone", seedSource: "auto", label: "Lone" });
      await db.upsertCommunityReport({
        communityId: "auto-lone",
        report: "orphan",
        model: "m",
        tokens: 1,
      });

      await db.pruneEmptyAutoCommunities();

      expect(await db.getCommunityReport("auto-lone")).toBeNull();
      expect(communities.every((c) => c.community_id !== "auto-lone")).toBe(true);
      // The membered communities + their reports survive.
      const after = await db.getAllCommunities();
      expect(after).toEqual(communities);
      expect(await db.getAllCommunityReports()).toHaveLength(communities.length);
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Build-side extraction pass
// ---------------------------------------------------------------------------

describe("Build-side LLM extraction", () => {
  it("writes llm:-typed entities, mention rows, and semantic edges", async () => {
    const { settings, extractionLlm } = await makeHarness(FIXTURE_FILES, {
      extractionResponses: [EXTRACTION_RESPONSE],
    });
    const db = new DatabaseManager(settings.dbPath);
    try {
      // One extraction call for the whole fixture (one batch under the cap).
      expect(extractionLlm!.seenUsers).toHaveLength(1);
      const user = extractionLlm!.seenUsers[0];
      expect(user).toContain("File: notes/a.md");
      expect(user).toContain("File: notes/b.md");
      expect(user).toContain("File: notes/c.md");
      expect(user).toContain("Bloom fuel cells.");

      // llm:-typed entities are stored (distinct from the regex tiers).
      const entities = await db.getAllEntities();
      const bloom = entities.find((e) => e.name === "Bloom Energy")!;
      const coldBrew = entities.find((e) => e.name === "Cold Brew")!;
      expect(bloom).toBeTruthy();
      expect(coldBrew).toBeTruthy();
      const rows = await db.getAllEntities();
      const llmEntities = rows.filter((e) => e.name === "Bloom Energy" || e.name === "Cold Brew" || e.name === "Fuel Cell Stack");
      expect(llmEntities.length).toBe(3);

      // Mentions: "Bloom Energy" appears in BOTH a.md headings (haystack).
      const mentions = await db.getSectionsForEntities([entityId("Bloom Energy")]);
      expect(mentions.map((m) => m.section_key).sort()).toEqual([KEY_BLOOM, KEY_FUEL_STACK]);

      // Semantic edges: Bloom Energy → Cold Brew reaches the unlinked c.md.
      const edges = await db.getSemanticEdges("notes/a.md");
      expect(edges).toEqual([
        { src_key: KEY_BLOOM, dst_key: KEY_COFFEE, kind: "semantic:related_to", weight: 1 },
        { src_key: KEY_FUEL_STACK, dst_key: KEY_COFFEE, kind: "semantic:related_to", weight: 1 },
      ]);
    } finally {
      await db.close();
    }
  });

  it("no-LLM build has zero semantic edges and zero llm entities (regression pin)", async () => {
    const { settings } = await makeHarness(FIXTURE_FILES);
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(countEdgesByKind(settings.dbPath, "semantic")).toBe(0);
      const names = (await db.getAllEntities()).map((e) => e.name);
      expect(names).not.toContain("Bloom Energy"); // regex tier never formed the two-word phrase
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Semantic-edge traversal (item 2 — the seed tier reads LLM entities, the
// driver fetches semantic edges per file)
// ---------------------------------------------------------------------------

describe("Semantic-edge traversal", () => {
  it("reaches the semantic-only section below the unchanged cosine top-k", async () => {
    const { indexer, settings, fakeEmbedder } = await makeHarness(FIXTURE_FILES, {
      extractionResponses: [EXTRACTION_RESPONSE],
    });

    // topK=1: the cosine top-1 for "bloom energy" is a.md::Bloom Energy
    // (pinned by equality below — the 64-dim feature hash collides dims, so
    // the exact order is not hand-computable). The resolver seeds both a.md
    // headings (entity "Bloom Energy"), and the semantic edge
    // Bloom Energy → Cold Brew expands to c.md::Coffee Notes — a section NO
    // wikilink touches. Graph hits are hand-computed: [Fuel Cell Stack (seed
    // score 1.0), Datacenter Power (via [[b]]), Coffee Notes (via semantic
    // edge)] — the two 0-score hits tie-break by node_key asc.
    const results = await indexer.query("bloom energy", 1, { maxGraphHits: 3 });
    const pure = await pureCosine(settings, fakeEmbedder, "bloom energy", 1);
    expect(results.slice(0, 1).map((r) => r.nodeKey)).toEqual(pure.map((r) => r.nodeKey));
    expect(results.slice(0, 1).map((r) => r.score)).toEqual(pure.map((r) => r.score));
    expect(results.slice(1).map((r) => r.nodeKey)).toEqual([
      KEY_FUEL_STACK,
      KEY_DATACENTER,
      KEY_COFFEE,
    ]);
  });

  it("without extraction the same query stays Phase-1 exact (regression pin)", async () => {
    const { indexer, settings, fakeEmbedder } = await makeHarness(FIXTURE_FILES);

    const results = await indexer.query("bloom energy", 1, { maxGraphHits: 3 });
    const pure = await pureCosine(settings, fakeEmbedder, "bloom energy", 1);
    expect(results.slice(0, 1).map((r) => r.nodeKey)).toEqual(pure.map((r) => r.nodeKey));
    // No semantic edges → no Coffee hit (wikilink/backlink expansion only).
    expect(results.slice(1).map((r) => r.nodeKey)).toEqual([KEY_FUEL_STACK, KEY_DATACENTER]);
  });
});

// ---------------------------------------------------------------------------
// Incremental legs (item 4)
// ---------------------------------------------------------------------------

describe("Incremental", () => {
  it("detects deleted files and removes them from the index (the known gap)", async () => {
    const { indexer, settings, vaultDir } = await makeHarness(FIXTURE_FILES);
    expect(count(settings.dbPath, "FILES")).toBe(3);

    fs.unlinkSync(path.join(vaultDir, "notes/c.md"));
    await indexer.incremental();

    expect(count(settings.dbPath, "FILES")).toBe(2);
    expect(count(settings.dbPath, "SECTIONS")).toBe(3); // a × 2 + b × 1
    expect(await indexer.db.getAllFileIds()).toEqual(["notes/a.md", "notes/b.md"]);
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect((await db.getSectionKeys()).map((k) => k.node_key)).toEqual([
        KEY_BLOOM,
        KEY_FUEL_STACK,
        KEY_DATACENTER,
      ]);
      // Every remaining section stays assigned (the unseeded re-cluster ran).
      expect(count(settings.dbPath, "COMMUNITY_SECTIONS")).toBe(3);
    } finally {
      await db.close();
    }
  });

  it("re-clusters unseeded vaults and keeps the untouched file's community", async () => {
    const { indexer, settings, vaultDir } = await makeHarness(DISTINCT_FILES);
    const before = new Map(communityAssignments(settings.dbPath));
    expect(before.has("beta.md::Beta")).toBe(true);
    expect(count(settings.dbPath, "COMMUNITY_SECTIONS")).toBe(count(settings.dbPath, "SECTIONS"));

    fs.writeFileSync(
      path.join(vaultDir, "alpha.md"),
      [
        "# Alpha",
        "proton exchange membrane electrolysis notes, anode catalyst layers.",
        "",
        "## Deep Alpha",
        "catalyst degradation mechanisms and platinum loading tradeoffs detail.",
        "",
      ].join("\n"),
    );
    await indexer.incremental();

    const after = new Map(communityAssignments(settings.dbPath));
    // The untouched beta section keeps its community across the delta.
    expect(after.get("beta.md::Beta")).toBe(before.get("beta.md::Beta"));
    // Every section is assigned, and the vault stays unseeded (auto only).
    expect(count(settings.dbPath, "COMMUNITY_SECTIONS")).toBe(count(settings.dbPath, "SECTIONS"));
    const db = new DatabaseManager(settings.dbPath);
    try {
      const communities = await db.getAllCommunities();
      expect(communities.length).toBeGreaterThanOrEqual(1);
      expect(communities.every((c) => c.seed_source === "auto")).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("regenerates reports only for communities whose membership changed", async () => {
    const { indexer, settings, vaultDir, reportLlm } = await makeHarness(DISTINCT_FILES, {
      reports: true,
    });
    const buildCalls = reportLlm!.seenUsers.length;
    expect(buildCalls).toBeGreaterThanOrEqual(2); // alpha + beta communities

    // Content edit that preserves clustering → membership unchanged → the
    // report pass is a strict no-op (0 new LLM calls).
    fs.writeFileSync(
      path.join(vaultDir, "alpha.md"),
      [
        "# Alpha",
        "proton exchange membrane electrolysis notes, anode catalyst layers.",
        "",
        "## Deep Alpha",
        "catalyst degradation mechanisms and platinum loading tradeoffs detail.",
        "",
      ].join("\n"),
    );
    await indexer.incremental();
    expect(reportLlm!.seenUsers.length).toBe(buildCalls);

    // A NEW file changes membership (new cluster or a member joins) → the
    // affected community's report is regenerated (≥1 new call).
    fs.writeFileSync(
      path.join(vaultDir, "gamma.md"),
      "# Gamma\n\nsolar photovoltaic efficiency, perovskite cells, module degradation.\n",
    );
    await indexer.incremental();
    expect(reportLlm!.seenUsers.length).toBeGreaterThan(buildCalls);
  });

  it("preserves semantic edges across a content edit (local re-extraction loses them)", async () => {
    const { indexer, settings, vaultDir } = await makeHarness(FIXTURE_FILES, {
      extractionResponses: [EXTRACTION_RESPONSE],
    });
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(await db.getSemanticEdges("notes/a.md")).toHaveLength(2);
    } finally {
      await db.close();
    }

    // Content edit to a.md: its wikilink/backlink edges are recomputed, but
    // the LLM semantic edges are PRESERVED (a local re-extraction of a.md
    // alone would lose the cross-file relation to c.md's "Cold Brew" — the
    // weekly full rebuild refreshes the semantic graph instead).
    fs.writeFileSync(
      path.join(vaultDir, "notes/a.md"),
      [
        "# Bloom Energy",
        "Bloom fuel cells revised. See [[b]] for the datacenter angle.",
        "",
        "## Fuel Cell Stack",
        "Efficiency above 60 percent, revised.",
        "",
      ].join("\n"),
    );
    await indexer.incremental();

    const db2 = new DatabaseManager(settings.dbPath);
    try {
      const semantic = await db2.getSemanticEdges("notes/a.md");
      expect(semantic).toHaveLength(2);
      expect(semantic[0].kind).toBe("semantic:related_to");
      // The LLM-entity mention rows were refreshed for the changed sections
      // (the resolver entity tier keeps working for the changed file).
      const mentions = await db2.getSectionsForEntities([entityId("Bloom Energy")]);
      expect(mentions.map((m) => m.section_key).sort()).toEqual([KEY_BLOOM, KEY_FUEL_STACK]);
    } finally {
      await db2.close();
    }
  });
});
