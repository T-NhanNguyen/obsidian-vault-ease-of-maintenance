// Integration tests — hybrid local search (Phase 1 of the GraphRAG buildout,
// .dev-vault/handoff.md). Builds a real index through Indexer.build (fake
// embedder + temp vault, the MemIO-style harness from pipeline.test.ts) and
// pins, by hand:
//   1. The four new DB reads (protocol + dispatch round trips through the
//      DatabaseManager facade → in-process worker channel → sql.js engine).
//   2. The EXACT hybrid query result for a crafted question: the pure-cosine
//      top-k unchanged, then the hand-computed graph-expanded section.
//   3. Regression pins: queries with no resolver/graph signal return the
//      pure-cosine result exactly.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";
import { DatabaseManager } from "../../src/indexer/db";

// ---------------------------------------------------------------------------
// Fixture vault — three files, hand-placed wikilinks.
//   notes/a.md — two sections; links to [[b]] (bare target, no .md)
//   notes/b.md — one section; links back to [[a]]
//   notes/c.md — one section; no links (the no-graph control)
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
    agent: { model: "test", enableThinking: false },
    preview: { enabled: true, ttlMinutes: 30 },
    index: { warnMb: 256 },
  };
}

interface BuiltHarness {
  indexer: Indexer;
  settings: Settings;
  fakeEmbedder: FakeEmbedder;
}

async function buildHarness(): Promise<BuiltHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-graph-search-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"));
  const fakeEmbedder = new FakeEmbedder(64);
  const indexer = new Indexer(settings, fakeEmbedder);
  await indexer.build();
  return { indexer, settings, fakeEmbedder };
}

/** Pure-cosine top-k for a question (the pre-Phase-1 query path). */
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

describe("Graph-search DB reads (round trips)", () => {
  it("getSectionKeys returns heading-only rows (no text/embedding)", async () => {
    const { settings } = await buildHarness();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const keys = await db.getSectionKeys();
      const rows = keys.map((k) => ({ key: k.node_key, heading: k.heading_path }));
      expect(rows).toEqual([
        { key: KEY_BLOOM, heading: "Bloom Energy" },
        { key: KEY_FUEL_STACK, heading: "Bloom Energy › Fuel Cell Stack" },
        { key: KEY_DATACENTER, heading: "Datacenter Power" },
        { key: KEY_COFFEE, heading: "Coffee Notes" },
      ]);
      for (const key of keys) {
        expect(Object.prototype.hasOwnProperty.call(key, "text")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(key, "embedding")).toBe(false);
      }
    } finally {
      await db.close();
    }
  });

  it("getAllEntities returns entity names", async () => {
    const { settings } = await buildHarness();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const entities = await db.getAllEntities();
      const names = entities.map((e) => e.name).sort();
      // Phrase + wikilink entities from the three section texts.
      expect(names).toEqual(["Back", "Bloom", "Cold", "Efficiency", "a", "b"]);
    } finally {
      await db.close();
    }
  });

  it("getSectionsForEntities maps an entity to its mentioning sections", async () => {
    const { settings } = await buildHarness();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const entities = await db.getAllEntities();
      const bloom = entities.find((e) => e.name === "Bloom")!;
      const mentions = await db.getSectionsForEntities([bloom.entity_id]);
      expect(mentions.map((m) => m.section_key)).toEqual([KEY_BLOOM]);
    } finally {
      await db.close();
    }
  });

  it("getSectionsByKeys resolves section keys and bare wikilink targets", async () => {
    const { settings } = await buildHarness();
    const db = new DatabaseManager(settings.dbPath);
    try {
      // "b" is the bare wikilink target stored in EDGES by computeWikilinkEdges;
      // "notes/a.md::Bloom Energy" is a real section key.
      const rows = await db.getSectionsByKeys([KEY_BLOOM, "b"]);
      expect(rows.map((r) => r.node_key).sort()).toEqual([KEY_BLOOM, KEY_DATACENTER]);
      expect(rows[0].text).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(rows[0], "embedding")).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("getSectionsByKeys returns nothing for unknown keys", async () => {
    const { settings } = await buildHarness();
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(await db.getSectionsByKeys(["does-not-exist"])).toEqual([]);
      expect(await db.getSectionsByKeys([])).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Hybrid query — exactness
// ---------------------------------------------------------------------------

describe("Hybrid query", () => {
  it("appends the linked section below the unchanged cosine top-k", async () => {
    const { indexer, settings, fakeEmbedder } = await buildHarness();

    // topK=2. The cosine prefix is pinned by EQUALITY against the pure-
    // cosine read (regression pin — the fake embedder's 64-dim feature
    // hash has dim collisions, so the exact zero-score ordering is not
    // hand-computable). The graph additions ARE hand-computable: the
    // resolver seeds both a.md headings ("bloom energy"), the second seed
    // (Fuel Cell Stack) is outside the cosine top-2, and [[b]] expands to
    // b.md's section. So: [cosine top-2] + [Fuel Cell Stack, Datacenter Power].
    const results = await indexer.query("bloom energy", 2);
    const pure = await pureCosine(settings, fakeEmbedder, "bloom energy", 2);
    expect(results.slice(0, 2).map((r) => r.nodeKey)).toEqual(pure.map((r) => r.nodeKey));
    expect(results.slice(0, 2).map((r) => r.score)).toEqual(pure.map((r) => r.score));
    expect(results.slice(2).map((r) => r.nodeKey)).toEqual([
      KEY_FUEL_STACK,
      KEY_DATACENTER,
    ]);
  });

  it("resolves bare wikilink targets to the linked file's sections", async () => {
    const { indexer } = await buildHarness();
    // "datacenter power" resolves b.md::Datacenter Power (heading match).
    // b.md links [[a]]; the bare target resolves to notes/a.md's sections,
    // of which Fuel Cell Stack is not in the cosine top-2 → it appends
    // below. Cosine top-2 is [Datacenter Power, Bloom Energy] (both share
    // the "datacenter" grams; Bloom Energy's body mentions datacenters).
    const results = await indexer.query("datacenter power", 2);
    expect(results.map((r) => r.nodeKey)).toEqual([
      KEY_DATACENTER,
      KEY_BLOOM,
      KEY_FUEL_STACK,
    ]);
  });

  it("no graph hits → result equals pure cosine exactly (regression pin)", async () => {
    const { indexer, settings, fakeEmbedder } = await buildHarness();
    // "banana smoothie" resolves no headings and no entities → cosine only.
    const results = await indexer.query("banana smoothie", 2);
    const pure = await pureCosine(settings, fakeEmbedder, "banana smoothie", 2);
    expect(results.map((r) => r.nodeKey)).toEqual(pure.map((r) => r.nodeKey));
    expect(results.map((r) => r.score)).toEqual(pure.map((r) => r.score));
  });

  it("resolver seeds that expand to nothing keep pure cosine (regression pin)", async () => {
    const { indexer, settings, fakeEmbedder } = await buildHarness();
    // "cold brew" resolves c.md (entity "Cold"), but c.md has no edges —
    // the expanded set adds nothing below the cosine top-k.
    const results = await indexer.query("cold brew", 2);
    const pure = await pureCosine(settings, fakeEmbedder, "cold brew", 2);
    expect(results.map((r) => r.nodeKey)).toEqual(pure.map((r) => r.nodeKey));
  });

  it("depth 2 expands through the linked note's own edges", async () => {
    const { indexer } = await buildHarness();
    // Depth 2 from the "bloom energy" seeds: level 1 reaches b ([[b]]);
    // level 2 follows b's backlink to notes/a.md (visited) — nothing new is
    // added beyond the depth-1 result (cycle-safe), and the result stays
    // deterministic and identical to depth 1.
    const depth1 = await indexer.query("bloom energy", 2);
    const depth2 = await indexer.query("bloom energy", 2, { depth: 2 });
    expect(depth2.map((r) => r.nodeKey)).toEqual(depth1.map((r) => r.nodeKey));
    expect(depth2.length).toBe(4);
  });
});
