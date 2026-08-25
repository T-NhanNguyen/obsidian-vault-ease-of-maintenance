// Unit tests for manifest and TOC parsing.
// Ported from tests/unit/test_manifest.py

import { describe, it, expect } from "vitest";
import { ManifestParser } from "../../src/indexer/manifest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Path to the sample vault fixture (copied from original repo)
const FIXTURE_VAULT_DIR = path.resolve(
  __dirname, "..", "..", "..", "notes-maintainer", "tests", "fixtures", "vaults", "sample"
);

function golden(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "golden", name), "utf-8")
  );
}

describe("ManifestParsing", () => {
  it("parse fixture manifest finds folders", () => {
    const entries = new ManifestParser(FIXTURE_VAULT_DIR).parse();
    const roots = new Set(entries.map(e => e.folderPath));
    expect(roots).toEqual(new Set(["10_Stocks", "20_AI_Speculations"]));
  });

  it("parse fixture manifest children", () => {
    const entries = new ManifestParser(FIXTURE_VAULT_DIR).parse();
    const stocks = entries.find(e => e.folderPath === "10_Stocks")!;
    const childPaths = new Set(stocks.children.map(c => c.folderPath));
    expect(childPaths).toEqual(new Set(["10_Stocks/Bloom_Energy", "10_Stocks/IREN"]));
  });

  it("parse fixture manifest files", () => {
    const entries = new ManifestParser(FIXTURE_VAULT_DIR).parse();
    const spec = entries.find(e => e.folderPath === "20_AI_Speculations")!;
    const names = new Set(spec.files.map(f => f.name));
    expect(names).toEqual(new Set([
      "datacenter-power-demand.md",
      "inference-cost-curve.md",
      "sovereign-ai.md",
    ]));
  });

  it("no manifest degraded", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-manifest-"));
    const entries = new ManifestParser(tmpDir).parse();
    expect(entries).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manifest hash stable", () => {
    const parser = new ManifestParser(FIXTURE_VAULT_DIR);
    const manifestPath = parser.findManifest();
    expect(parser.hashManifest(manifestPath)).toBe(parser.hashManifest(manifestPath));
  });
});

describe("CommunitySeeds", () => {
  it("fixture seeds match golden", () => {
    const parser = new ManifestParser(FIXTURE_VAULT_DIR);
    const manifestPath = parser.findManifest();
    const seeds = parser.getCommunitySeeds(manifestPath);
    const got = seeds.map(s => ({
      community_id: s.communityId,
      seed_source: s.seedSource,
      label: s.label,
      folder_path: s.folderPath,
    }));
    expect({ seeds: got }).toEqual(golden("manifest_seeds.json"));
  });

  it("no manifest no seeds", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-seeds-"));
    const seeds = new ManifestParser(tmpDir).getCommunitySeeds(null);
    expect(seeds).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("nested folder paths not duplicated", () => {
    const parser = new ManifestParser(FIXTURE_VAULT_DIR);
    const seeds = parser.getCommunitySeeds(parser.findManifest());
    const paths = new Set(seeds.map(s => s.folderPath));
    expect(paths.has("10_Stocks/Bloom_Energy")).toBe(true);
    expect(paths.has("10_Stocks/10_Stocks/Bloom_Energy")).toBe(false);
  });

  it("stale root entries never become community seeds", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "test-root-seeds-"));
    fs.writeFileSync(
      path.join(vault, "_manifest.md"),
      "# vault\n\n## ./ <!-- (needs review) -->\n     root.md\n\n## 10_Stocks/ <!-- stock research -->\n",
      "utf-8",
    );

    const parser = new ManifestParser(vault);
    const seeds = parser.getCommunitySeeds(parser.findManifest());
    expect(seeds.some(s => s.folderPath === "." || s.folderPath === "")).toBe(false);
    expect(seeds.map(s => s.folderPath)).toEqual(["10_Stocks"]);
    fs.rmSync(vault, { recursive: true, force: true });
  });
});
