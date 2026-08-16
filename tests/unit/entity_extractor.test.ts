// Unit tests for the regex-based entity extractor.
// Ported from tests/unit/test_entity_extractor.py

import { describe, it, expect } from "vitest";
import { EntityExtractor } from "../../src/indexer/graph";
import { Chunker } from "../../src/indexer/chunker";
import { Scanner } from "../../src/indexer/scanner";
import * as path from "path";
import * as fs from "fs";

const FIXTURE_VAULT_DIR = path.resolve(
  __dirname, "..", "..", "..", "notes-maintainer", "tests", "fixtures", "vaults", "sample"
);

function golden(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "golden", name), "utf-8")
  );
}


describe("Extraction", () => {
  it("wikilinks extracted", () => {
    const entities = new EntityExtractor().extract("See [[Alpha]] and [[Beta|label]].");
    const names = new Set(entities.filter(e => e.type === "wikilink").map(e => e.name));
    expect(names).toEqual(new Set(["Alpha", "Beta"]));
  });

  it("tags extracted", () => {
    const entities = new EntityExtractor().extract("Notes #ai and #data-centers here.");
    const names = new Set(entities.filter(e => e.type === "tag").map(e => e.name));
    expect(names).toEqual(new Set(["#ai", "#data-centers"]));
  });

  it("capitalized phrases extracted", () => {
    const entities = new EntityExtractor().extract("Bloom Energy builds fuel cells.");
    const phrases = entities.filter(e => e.type === "phrase").map(e => e.name);
    expect(phrases).toContain("Bloom Energy");
  });

  it("short phrases skipped", () => {
    const entities = new EntityExtractor().extract("A B is short. X Y Z also.");
    const phrases = entities.filter(e => e.type === "phrase").map(e => e.name);
    expect(phrases.every(p => p.length >= 4)).toBe(true);
  });

  it("dedupe across types", () => {
    const entities = new EntityExtractor().extract("[[Bloom]] and #Bloom and Bloom again.");
    const ids = entities.map(e => e.entityId);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("WikilinkEdges", () => {
  it("section edges created", () => {
    const extractor = new EntityExtractor();
    const sections = [{ nodeKey: "a.md::Intro", text: "See [[b]] for details." }];
    const edges = extractor.computeWikilinkEdges(sections, "a.md");
    expect(edges[0].srcKey).toBe("a.md::Intro");
    expect(edges[0].dstKey).toBe("b");
    expect(edges[0].kind).toBe("wikilink");
  });

  it("anchor target resolved", () => {
    const extractor = new EntityExtractor();
    const sections = [{ nodeKey: "a.md::Intro", text: "See [[b#Deep]]." }];
    const edges = extractor.computeWikilinkEdges(sections, "a.md");
    expect(edges[0].dstKey).toBe("b::Deep");
  });

  it("self reference skipped", () => {
    const extractor = new EntityExtractor();
    const sections = [{ nodeKey: "a.md::Intro", text: "See [[a.md::Intro]]." }];
    const edges = extractor.computeWikilinkEdges(sections, "a.md");
    expect(edges.length).toBe(0);
  });
});

describe("Backlinks", () => {
  it("backlinks derived from wikilinks", () => {
    const extractor = new EntityExtractor();
    const wikilinks = [{
      srcKey: "a.md::Intro",
      dstKey: "b.md::Deep",
      kind: "wikilink",
      weight: 1.0,
    }];
    const backlinks = extractor.computeBacklinks(wikilinks);
    const kinds = new Set(backlinks.map(e => e.kind));
    expect(kinds).toEqual(new Set(["backlink"]));
  });
});

describe("InferredEdges", () => {
  it("similar sections connected", () => {
    const extractor = new EntityExtractor();
    const sections = [
      { nodeKey: "a.md::X", embedding: [1.0, 0.0, 0.0] },
      { nodeKey: "b.md::Y", embedding: [0.9, 0.1, 0.0] },
      { nodeKey: "c.md::Z", embedding: [0.0, 0.0, 1.0] },
    ];
    const edges = extractor.computeInferredEdges(sections, new Set(), 0.7);
    const srcKeys = new Set(edges.map(e => e.srcKey));
    expect(srcKeys.has("a.md::X")).toBe(true);
    expect(srcKeys.has("c.md::Z")).toBe(false);
  });
});

describe("FixtureGolden", () => {
  it("fixture entities match golden", () => {
    const files = new Scanner(FIXTURE_VAULT_DIR)
      .scan()
      .filter(f => path.basename(f.path) !== "_manifest.md");
    const chunker = new Chunker();
    const extractor = new EntityExtractor();
    const got: Record<string, Record<string, string[]>> = {};
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const sections = chunker.chunk(f);
      const text = sections.map(s => s.text).join("\n");
      const entities = extractor.extract(text);
      got[f.path] = {
        wikilink: entities.filter(e => e.type === "wikilink").map(e => e.name).sort(),
        tag: entities.filter(e => e.type === "tag").map(e => e.name).sort(),
        phrase: entities.filter(e => e.type === "phrase").map(e => e.name).sort(),
      };
    }
    expect(got).toEqual(golden("entities.json"));
  });
});
