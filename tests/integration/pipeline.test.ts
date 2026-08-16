// Integration tests — full pipeline with the fake embedder.
// Ported from tests/integration/test_pipeline.py (better-sqlite3 era).

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";

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

// Deep-partial override shape for the tuning tests — only query/graph are
// ever overridden here.
interface SettingsOverrides {
  query?: Partial<Settings["query"]>;
  graph?: Partial<Settings["graph"]>;
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
    query: { topK: 5, depth: 1, maxFanOut: 8, maxSeeds: 8 },
    agent: { model: "test", thinking: { chat: false, build: false, sort: false } },
    preview: { enabled: true, ttlMinutes: 30 },
    index: { warnMb: 256 },
    graph: {
      clusterThreshold: 0.5,
      inferredThreshold: 0.7,
      inferredMaxEdgesPerSection: 3,
    },
  };
  return {
    ...base,
    ...overrides,
    query: { ...base.query, ...overrides.query },
    graph: { ...base.graph, ...overrides.graph },
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

  it("bloom query ranks bloom first", async () => {
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const results = await indexer.query("bloom energy fuel cells", 3);
    expect(results[0].filePath).toBe("10_Stocks/Bloom_Energy/bloom-energy-overview.md");
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

  it("query returns citation fields", async () => {
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const results = await indexer.query("sovereign ai strategies", 2);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("nodeKey");
      expect(r).toHaveProperty("filePath");
      expect(r).toHaveProperty("headingPath");
      expect(r).toHaveProperty("text");
      expect(r).toHaveProperty("score");
    }
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
