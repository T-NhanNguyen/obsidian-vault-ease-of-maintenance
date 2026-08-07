// Integration tests — full pipeline with the fake embedder.
// Ported from tests/integration/test_pipeline.py

import { describe, it, expect, beforeAll } from "vitest";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import Database from "better-sqlite3";

// Path to the sample vault fixture (original repo, sibling directory)
const FIXTURE_VAULT_DIR = path.resolve(
  __dirname, "..", "..", "..", "notes-maintainer", "tests", "fixtures", "vaults", "sample"
);

function count(dbPath: string, table: string): number {
  const conn = new Database(dbPath);
  try {
    return (conn.prepare(`SELECT COUNT(*) FROM ${table}`).get() as any)["COUNT(*)"];
  } finally {
    conn.close();
  }
}

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
    query: { topK: 5 },
    agent: { model: "test" },
    preview: { enabled: true, ttlMinutes: 30 },
  };
}

// indexer_factory: build an Indexer wired to the fake embedder + temp vault.
async function indexerFactory(
  files: Record<string, string>,
): Promise<{ indexer: Indexer; settings: Settings; vaultDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-indexer-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"));
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
    const conn = new Database(settings.dbPath);
    try {
      const row = conn.prepare(
        "SELECT COUNT(*) FROM SECTIONS WHERE embedding IS NOT NULL"
      ).get() as any;
      expect(row["COUNT(*)"]).toBe(20);
    } finally {
      conn.close();
    }
  });

  it("manifest communities seeded", async () => {
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();
    const communities = indexer.db.getAllCommunities();
    const seeds = new Set(communities.map((c: any) => c.seed_source));
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
    const meta = indexer.db.getLatestMeta();
    expect(meta).not.toBeNull();
  });
});

describe("DegradedMode", () => {
  it("build without manifest", async () => {
    const { indexer, settings } = await indexerFactory({ "note.md": "# Hi\n\nBody.\n" });
    await indexer.build();
    expect(count(settings.dbPath, "FILES")).toBe(1);
    expect(count(settings.dbPath, "COMMUNITIES")).toBe(0);
  });

  it("no headings file gets root section", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-root-section-"));
    const settings = makeSettings(FIXTURE_VAULT_DIR, path.join(tmpDir, "index.db"));
    const fakeEmbedder = new FakeEmbedder(64);
    const indexer = new Indexer(settings, fakeEmbedder);
    await indexer.build();

    const sections = indexer.db.getSectionsForFile(
      "20_AI_Speculations/inference-cost-curve.md"
    );
    expect(sections.length).toBeGreaterThan(0);
    expect((sections[0] as any).node_key.endsWith("::")).toBe(true);
  });
});
