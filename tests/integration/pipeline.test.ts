// Integration tests — full pipeline with the fake embedder.
// Ported from tests/integration/test_pipeline.py (better-sqlite3 era).

import { describe, it, expect, beforeAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings, defaultSettings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";
import { DatabaseManager } from "../../src/indexer/db";
import type { ReportLlm, ReportLlmResult } from "../../src/indexer/community_reports";

// Path to the sample vault fixture (original repo, sibling directory)
const FIXTURE_VAULT_DIR = path.resolve(
  __dirname, "..", "..", "..", "notes-maintainer", "tests", "fixtures", "vaults", "sample"
);

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

function countEmbedded(dbPath: string): number {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const row = conn.exec("SELECT COUNT(*) FROM SECTIONS WHERE embedding IS NOT NULL")[0]?.values[0]?.[0];
    return typeof row === "number" ? row : 0;
  } finally {
    conn.close();
  }
}

/** section_key → community_id, sorted for comparison across builds. */
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

/** community_id → seed_source, sorted for comparison across builds. */
function communityRows(dbPath: string): Array<[string, string]> {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const rows = conn.exec("SELECT community_id, seed_source FROM COMMUNITIES")[0]?.values ?? [];
    return rows
      .map((r) => [String(r[0]), String(r[1])] as [string, string])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  } finally {
    conn.close();
  }
}

// Deep-partial override shape for the tuning tests — only query/graph/
// reports are ever overridden here.
interface SettingsOverrides {
  query?: Partial<Settings["query"]>;
  graph?: Partial<Settings["graph"]>;
  reports?: Partial<Settings["reports"]>;
}

function makeSettings(
  vaultPath: string,
  dbPath: string,
  overrides: SettingsOverrides = {},
): Settings {
  const base: Settings = {
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
    reports: {
      contextCapTokens: 3000,
    },
    extraction: {
      contextCapTokens: 3000,
    },
    comprehension: defaultSettings().comprehension,
  };
  return {
    ...base,
    ...overrides,
    query: { ...base.query, ...overrides.query },
    graph: { ...base.graph, ...overrides.graph },
    reports: { ...base.reports, ...overrides.reports },
  };
}

// indexer_factory: build an Indexer wired to the fake embedder + temp vault.
async function indexerFactory(
  files: Record<string, string>,
  overrides: SettingsOverrides = {},
): Promise<{ indexer: Indexer; settings: Settings; vaultDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-indexer-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"), overrides);
  const fakeEmbedder = new FakeEmbedder(64);
  return { indexer: new Indexer(settings, fakeEmbedder), settings, vaultDir };
}

describe("FullBuild", () => {
  let settings: Settings;
  let fakeEmbedder: FakeEmbedder;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-pipeline-"));
    fakeEmbedder = new FakeEmbedder(64);
    settings = makeSettings(FIXTURE_VAULT_DIR, path.join(tmpDir, "index.db"));
  });

  it("build populates tables", async () => {
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const dbPath = settings.dbPath;

    // 7 files (8 md - manifest)
    expect(count(dbPath, "FILES")).toBe(7);
    // 20 sections (matches goldens)
    expect(count(dbPath, "SECTIONS")).toBe(20);
    expect(count(dbPath, "ENTITIES")).toBeGreaterThan(0);
    expect(count(dbPath, "EDGES")).toBeGreaterThan(0);
    expect(count(dbPath, "COMMUNITIES")).toBe(4);
    expect(count(dbPath, "INDEX_META")).toBe(1);
  });

  it("build sections have embeddings", async () => {
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    expect(countEmbedded(settings.dbPath)).toBe(20);
  });

  it("manifest communities seeded", async () => {
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const communities = await indexer.db.getAllCommunities();
    const seeds = new Set(communities.map((c) => c.seed_source));
    expect(seeds).toEqual(new Set(["manifest"]));
  });
});

describe("QueryRanking", () => {
  let settings: Settings;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-query-"));
    settings = makeSettings(FIXTURE_VAULT_DIR, path.join(tmpDir, "index.db"));
  });

  it("bloom query ranks bloom first and results carry the citation contract", async () => {
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const results = await indexer.query("bloom energy fuel cells", 3);
    expect(results[0].filePath).toBe("10_Stocks/Bloom_Energy/bloom-energy-overview.md");
    // The chat answer path renders provenance from these fields — the query
    // must always return them, not just a ranked path list.
    for (const r of results) {
      expect(r).toHaveProperty("nodeKey");
      expect(r).toHaveProperty("filePath");
      expect(r).toHaveProperty("headingPath");
      expect(r).toHaveProperty("text");
      expect(r).toHaveProperty("score");
    }
  });

  it("bitcoin query ranks iren first", async () => {
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const results = await indexer.query("bitcoin mining", 3);
    expect(results[0].filePath).toBe("10_Stocks/IREN/iren-overview.md");
  });

  it("grid query ranks datacenter first", async () => {
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const results = await indexer.query("grid generation queues", 3);
    expect(results[0].filePath).toBe("20_AI_Speculations/datacenter-power-demand.md");
  });
});

describe("Incremental", () => {
  it("incremental overwrite keeps section count", async () => {
    const { indexer, settings, vaultDir } = await indexerFactory({
      "a.md": "# Intro\n\nBody A.\n\n## Deep\n\nDeep A.\n",
      "b.md": "# B\n\nBody B.\n",
    });
    await indexer.build();
    const before = count(settings.dbPath, "SECTIONS");

    fs.writeFileSync(
      path.join(vaultDir, "a.md"),
      "# Intro\n\nBody A, edited.\n\n## Deep\n\nDeep A, edited.\n"
    );

    await indexer.incremental();
    const after = count(settings.dbPath, "SECTIONS");
    expect(after).toBe(before);
  });

  it("incremental tracks file change", async () => {
    const { indexer, settings, vaultDir } = await indexerFactory({
      "a.md": "# A\n\nBody.\n",
    });
    await indexer.build();

    fs.writeFileSync(path.join(vaultDir, "a.md"), "# A\n\nBody changed.\n");

    await indexer.incremental();
    const meta = await indexer.db.getLatestMeta();
    expect(meta).not.toBeNull();
  });
});

describe("DegradedMode", () => {
  it("build without manifest auto-clusters communities", async () => {
    const { indexer, settings } = await indexerFactory({ "note.md": "# Hi\n\nBody.\n" });
    await indexer.build();
    expect(count(settings.dbPath, "FILES")).toBe(1);
    // Phase 3: an unseeded vault gets ≥1 auto community and EVERY section
    // is assigned (the old contract of 0 communities is superseded).
    expect(count(settings.dbPath, "COMMUNITIES")).toBeGreaterThanOrEqual(1);
    expect(count(settings.dbPath, "COMMUNITY_SECTIONS")).toBe(count(settings.dbPath, "SECTIONS"));
  });

  it("unseeded builds are deterministic — same clusters across two builds", async () => {
    const files = {
      "a.md": "# Alpha\n\nbloom energy fuel cells overview.\n\n## Deep\n\nMore alpha detail.\n",
      "b.md": "# Beta\n\nbitcoin mining halving rewards network.\n",
    };
    const first = await indexerFactory(files);
    await first.indexer.build();
    const second = await indexerFactory(files);
    await second.indexer.build();

    expect(communityRows(first.settings.dbPath)).toEqual(communityRows(second.settings.dbPath));
    expect(communityAssignments(first.settings.dbPath)).toEqual(
      communityAssignments(second.settings.dbPath),
    );
    // And every section is assigned in both.
    expect(count(first.settings.dbPath, "COMMUNITY_SECTIONS")).toBe(
      count(first.settings.dbPath, "SECTIONS"),
    );
    expect(count(second.settings.dbPath, "COMMUNITY_SECTIONS")).toBe(
      count(second.settings.dbPath, "SECTIONS"),
    );
  });

  it("one-file edit keeps the untouched file's sections in the same communities", async () => {
    const files = {
      // Distinct topics with NO shared grams between files: an edit to a.md
      // cannot pull b.md's sections across the cluster threshold.
      "a.md": "# Alpha\n\nbloom energy fuel cells overview.\n\n## Deep\n\nNotes on the section structure.\n",
      "b.md": "# Beta\n\nbitcoin mining halving rewards network.\n",
    };
    const { indexer, settings, vaultDir } = await indexerFactory(files);
    await indexer.build();
    const before = new Map(communityAssignments(settings.dbPath));

    // One-file change: edit a.md only; b.md is untouched.
    fs.writeFileSync(
      path.join(vaultDir, "a.md"),
      "# Alpha\n\nbloom energy fuel cells overview, revised with fresh detail.\n\n## Deep\n\nNotes on the section structure.\n",
    );
    const rebuilt = new Indexer(settings, new FakeEmbedder(64));
    await rebuilt.build();
    const after = new Map(communityAssignments(settings.dbPath));

    // The untouched file's sections keep their community ids across the edit.
    expect(after.get("b.md::Beta")).toBe(before.get("b.md::Beta"));
  });

  it("no headings file gets root section", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-root-section-"));
    const settings = makeSettings(FIXTURE_VAULT_DIR, path.join(tmpDir, "index.db"));
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();

    const sections = await indexer.db.getSectionsForFile(
      "20_AI_Speculations/inference-cost-curve.md"
    );
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0].node_key.endsWith("::")).toBe(true);
  });
});

function countEdgesByKind(dbPath: string, kind: string): number {
  const conn = new SQL.Database(fs.readFileSync(dbPath));
  try {
    // `kind` is a constant ('inferred') — never user input in this helper.
    const row = conn.exec(`SELECT COUNT(*) FROM EDGES WHERE kind = '${kind}'`)[0]?.values[0]?.[0];
    return typeof row === "number" ? row : 0;
  } finally {
    conn.close();
  }
}

// The config.yaml graph: section must actually reach the build (single
// source of truth for GraphRAG tuning). Monotonicity is guaranteed by
// construction: a higher cosine threshold can only reduce joins/edges.
describe("GraphConfigTuning", () => {
  const files = {
    "a.md": "# Alpha\n\nbloom energy fuel cells overview.\n\n## Deep\n\nNotes on the section structure.\n",
    "b.md": "# Beta\n\nbitcoin mining halving rewards network.\n",
  };

  it("graph.cluster_threshold tunes auto-community granularity", async () => {
    // 0.0 joins anything non-negatively-correlated (few, large communities);
    // 0.99 only joins near-identical sections (more, smaller communities).
    const coarse = await indexerFactory(files, { graph: { clusterThreshold: 0.0 } });
    await coarse.indexer.build();
    const fine = await indexerFactory(files, { graph: { clusterThreshold: 0.99 } });
    await fine.indexer.build();

    expect(count(fine.settings.dbPath, "COMMUNITIES")).toBeGreaterThanOrEqual(
      count(coarse.settings.dbPath, "COMMUNITIES"),
    );
    // Every section is assigned at both granularities.
    expect(count(coarse.settings.dbPath, "COMMUNITY_SECTIONS")).toBe(
      count(coarse.settings.dbPath, "SECTIONS"),
    );
    expect(count(fine.settings.dbPath, "COMMUNITY_SECTIONS")).toBe(
      count(fine.settings.dbPath, "SECTIONS"),
    );
  });

  it("graph.inferred_threshold tunes the inferred-edge density", async () => {
    const dense = await indexerFactory(files, { graph: { inferredThreshold: 0.0 } });
    await dense.indexer.build();
    const sparse = await indexerFactory(files, { graph: { inferredThreshold: 0.99 } });
    await sparse.indexer.build();

    expect(countEdgesByKind(sparse.settings.dbPath, "inferred")).toBeLessThanOrEqual(
      countEdgesByKind(dense.settings.dbPath, "inferred"),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase split — core index checkpoint, then non-fatal LLM enrichment
// ---------------------------------------------------------------------------

/** Extraction stub that records the on-disk core index on its first call:
 * a populated FILES table there proves the phase-1 checkpoint ran before
 * the reasoning model was touched. */
class CheckpointProbeLlm implements ReportLlm {
  readonly filesSeenOnFirstCall: number[] = [];

  constructor(private readonly probe: () => number) {}

  async complete(): Promise<ReportLlmResult> {
    if (this.filesSeenOnFirstCall.length === 0) this.filesSeenOnFirstCall.push(this.probe());
    return { content: "", totalTokens: 0, model: "stub-model" };
  }
}

/** Enrichment stub that always fails — phase 2 must stay non-fatal. */
class FailingEnrichmentLlm implements ReportLlm {
  async complete(): Promise<ReportLlmResult> {
    throw new Error("enrichment model down");
  }
}

/** Report stub — echoes only the community label. */
class LabelReportLlm implements ReportLlm {
  async complete(_system: string, user: string): Promise<ReportLlmResult> {
    const label = user.match(/Community: ([^\n]+)/)?.[1] || "unknown";
    return { content: `Summary of ${label}.`, totalTokens: 1, model: "stub-model" };
  }
}

describe("BuildPhaseSplit", () => {
  const files = {
    "notes/a.md": "# Bloom Energy\n\nBloom fuel cells. See [[b]].\n",
    "notes/b.md": "# Datacenter Power\n\nAI data centers. Back to [[a]].\n",
  };

  it("checkpoints the core index before enrichment and reports each phase boundary", async () => {
    const { indexer, settings } = await indexerFactory(files);
    const events: Array<{ message: string; kind?: "status" | "progress" }> = [];
    const extractionLlm = new CheckpointProbeLlm(() =>
      fs.existsSync(settings.dbPath) ? count(settings.dbPath, "FILES") : -1,
    );
    const splitIndexer = new Indexer(settings, indexer.embedder, new LabelReportLlm(), extractionLlm);

    await splitIndexer.build((message, kind) => events.push({ message, kind }));
    const progress = events.map((event) => event.message);

    // Phase 1 was checkpointed BEFORE extraction: the probe read a
    // populated FILES table from the vault file on the first LLM call.
    expect(extractionLlm.filesSeenOnFirstCall).toEqual([2]);
    // The chat's live phase messages, in order.
    expect(progress[0]).toMatch(/^Core index ready: 2 files in \d+s\. Retrieval works now\.$/);
    expect(progress[1]).toBe("Enrichment started: entity extraction and community reports.");
    expect(progress[progress.length - 1]).toMatch(/^Enrichment done: \d+ communities in \d+s\.$/);
    // Phase-2 per-call progress: transient (kind "progress") lines that name
    // the call in flight, so a stalled call is visible instead of silent.
    const transient = events.filter((event) => event.kind === "progress").map((e) => e.message);
    expect(transient.some((m) => /^Enrichment: entity extraction 1\/\d+\.$/.test(m))).toBe(true);
    expect(transient.some((m) => /^Enrichment: community reports \d+\/\d+\.$/.test(m))).toBe(true);
    // Enrichment landed on disk only after the checkpoint.
    expect(count(settings.dbPath, "COMMUNITY_REPORTS")).toBeGreaterThan(0);
  });

  it("keeps the core index usable when enrichment fails", async () => {
    const { indexer, settings } = await indexerFactory(files);
    const progress: string[] = [];
    const splitIndexer = new Indexer(
      settings,
      indexer.embedder,
      new FailingEnrichmentLlm(),
      new FailingEnrichmentLlm(),
    );

    await expect(splitIndexer.build((message) => progress.push(message))).resolves.toBeUndefined();

    expect(progress[progress.length - 1]).toMatch(
      /^Enrichment failed: enrichment model down.*\. The core index still works\.$/,
    );
    expect(count(settings.dbPath, "FILES")).toBe(2);
    expect(count(settings.dbPath, "SECTIONS")).toBeGreaterThan(0);
    expect(count(settings.dbPath, "COMMUNITY_SECTIONS")).toBe(count(settings.dbPath, "SECTIONS"));
  });

  it("checkpoint() persists live writes without closing the worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-checkpoint-"));
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    try {
      await db.initialize();
      await db.insertCommunity({ communityId: "c1", seedSource: "manifest", label: "C1" });
      await db.checkpoint();
      expect(count(dbPath, "COMMUNITIES")).toBe(1);
      // The worker stays open after the checkpoint: a later write still
      // reaches disk through close().
      await db.insertCommunity({ communityId: "c2", seedSource: "manifest", label: "C2" });
    } finally {
      await db.close();
    }
    expect(count(dbPath, "COMMUNITIES")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Failure safety — a failed write leg must never replace a good index
// ---------------------------------------------------------------------------

describe("IndexFailureSafety", () => {
  const files = {
    "notes/a.md": "# Alpha\n\nbloom energy fuel cells overview.\n",
    "notes/b.md": "# Beta\n\nbitcoin mining halving rewards.\n",
  };

  async function captureFailure(run: () => Promise<void>): Promise<Error> {
    try {
      await run();
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
    throw new Error("expected the call to fail");
  }

  it("phase-1 failure leaves the previous index untouched", async () => {
    const { indexer, settings } = await indexerFactory(files);
    await indexer.build();
    const before = fs.readFileSync(settings.dbPath);

    const failing = new Indexer(settings, indexer.embedder);
    vi.spyOn(failing.graph, "computeAllEdges").mockRejectedValueOnce(
      new Error("edge pass exploded"),
    );

    const error = await captureFailure(() => failing.build());
    expect(error.message).toMatch(/Core index failed: edge pass exploded/);
    expect(error.message).toMatch(/may be stale/);
    // The cleared/partial in-memory index was discarded, not exported.
    expect(fs.readFileSync(settings.dbPath).equals(before)).toBe(true);
    expect(count(settings.dbPath, "FILES")).toBe(2);
  });

  it("incremental failure leaves the previous index untouched", async () => {
    const { indexer, settings, vaultDir } = await indexerFactory(files);
    await indexer.build();
    const before = fs.readFileSync(settings.dbPath);

    fs.writeFileSync(path.join(vaultDir, "notes/c.md"), "# Gamma\n\nsolar inverter efficiency.\n");
    const failing = new Indexer(settings, indexer.embedder);
    vi.spyOn(failing.graph, "computeEdgesForFiles").mockRejectedValueOnce(
      new Error("edge recompute exploded"),
    );

    const error = await captureFailure(() => failing.incremental());
    expect(error.message).toMatch(/Incremental update failed: edge recompute exploded/);
    expect(fs.readFileSync(settings.dbPath).equals(before)).toBe(true);
    // The new file was never committed.
    expect(count(settings.dbPath, "FILES")).toBe(2);
  });

  it("journal replay failure leaves the previous index untouched", async () => {
    const { indexer, settings, vaultDir } = await indexerFactory(files);
    await indexer.build();
    const before = fs.readFileSync(settings.dbPath);

    fs.writeFileSync(path.join(vaultDir, "notes/c.md"), "# Gamma\n\nsolar inverter efficiency.\n");
    const failing = new Indexer(settings, indexer.embedder);
    vi.spyOn(failing.graph, "computeEdgesForFiles").mockRejectedValueOnce(
      new Error("edge recompute exploded"),
    );

    const error = await captureFailure(() =>
      failing.replayJournal([{ verdict: "new", file_path: "notes/c.md" }]),
    );
    expect(error.message).toMatch(/Journal replay failed: edge recompute exploded/);
    expect(fs.readFileSync(settings.dbPath).equals(before)).toBe(true);
    expect(count(settings.dbPath, "FILES")).toBe(2);
  });
});
