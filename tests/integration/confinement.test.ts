// Confinement integration test — builds a real index in a temp vault and
// asserts every artifact lands INSIDE the vault: nothing is created in the
// parent temp directory, the DB lands at .note-maintainer/index.db, and no
// .tmp- leftovers survive. Guards the VaultIO confinement layer end-to-end.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";

const FIXTURE_VAULT_DIR = path.resolve(
  __dirname, "..", "..", "..", "notes-maintainer", "tests", "fixtures", "vaults", "sample"
);

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

let parent: string;
let vault: string;

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "nm-confinement-"));
  vault = path.join(parent, "vault");
});

afterAll(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("vault confinement (end-to-end)", () => {
  it("index build + incremental write nothing outside the vault", async () => {
    fs.mkdirSync(vault, { recursive: true });
    const dbPath = path.join(vault, ".note-maintainer", "index.db");
    const settings = makeSettings(vault, dbPath);
    const indexer = new Indexer(settings, new FakeEmbedder());

    const outsideBefore = fs.readdirSync(parent).sort();
    await indexer.build();
    await indexer.incremental();
    const outsideAfter = fs.readdirSync(parent).sort();

    expect(outsideAfter).toEqual(outsideBefore);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(vault, ".note-maintainer", "index.db"))).toBe(true);

    const artifacts = fs.readdirSync(path.join(vault, ".note-maintainer"));
    expect(artifacts).toContain("index.db");
    expect(artifacts.some((a) => a.startsWith(".tmp-"))).toBe(false);
  });

  it("scanning the sample fixture vault is confined and finds its files", async () => {
    // Reuse the fixture vault as a read-only source: building there would
    // write, so just scan it.
    const { Scanner } = await import("../../src/indexer/scanner");
    const files = new Scanner(FIXTURE_VAULT_DIR).scan();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.path).not.toMatch(/\.\./);
    }
  });
});
