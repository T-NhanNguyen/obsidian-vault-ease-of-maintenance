// Unit tests for the markdown chunker.
// Ported from tests/unit/test_chunker.py

import { describe, it, expect } from "vitest";
import { Chunker, SectionInfo, FileInfoForChunking } from "../../src/indexer/chunker";
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


function fileInfo(path: string, content: string): FileInfoForChunking {
  return { path, content };
}

function sectionShape(section: SectionInfo): Record<string, unknown> {
  // Map TS camelCase fields to the golden file's snake_case keys —
  // mirrors the Python _section_shape pass-through exactly.
  return {
    node_key: section.nodeKey,
    heading_path: section.headingPath,
    heading_text: section.headingText,
    line_start: section.lineStart,
    line_end: section.lineEnd,
    content_hash: section.contentHash,
  };
}

describe("HeadingSplitting", () => {
  it("split by headings", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "# Intro\n\nBody.\n\n## Deep\n\nMore.\n")
    );
    expect(chunks.map(c => c.nodeKey)).toEqual([
      "a.md::Intro",
      "a.md::Intro › Deep",
    ]);
  });

  it("nested heading path", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "# A\n\n## A.B\n\n### A.B.C\n\nText.\n")
    );
    expect(chunks[chunks.length - 1].headingPath).toBe("A › A.B › A.B.C");
    expect(chunks[chunks.length - 1].headingText).toBe("A.B.C");
  });

  it("sibling headings reset path", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "# A\n\n## A.B\n\nx\n\n# C\n\n## C.D\n\ny\n")
    );
    const paths = chunks.map(c => c.headingPath);
    expect(paths).toContain("C › C.D");
    expect(paths).not.toContain("A › C.D");
  });

  it("no headings single root section", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "Just a paragraph.\nNo headings.\n")
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0].nodeKey).toBe("a.md::");
    expect(chunks[0].headingPath).toBe("");
  });

  it("frontmatter stripped", () => {
    const content = "---\ntitle: Sample\n---\n\n# H1\n\nBody text.\n";
    const chunks = new Chunker().chunk(fileInfo("a.md", content));
    expect(chunks[0].text).not.toContain("title:");
    expect(chunks[0].headingText).toBe("H1");
    expect(chunks[0].text).toBe("Body text.");
  });

  it("empty sections skipped", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "# A\n\n## Empty\n\n# C\n\nBody.\n")
    );
    const nodeKeys = chunks.map(c => c.nodeKey);
    expect(nodeKeys).not.toContain("a.md::A › Empty");
    expect(nodeKeys).toContain("a.md::C");
  });
});

describe("NodeKeyStability", () => {
  it("node key stable across edits", () => {
    const c1 = new Chunker().chunk(fileInfo("a.md", "# A\n\nBody one.\n"));
    const c2 = new Chunker().chunk(fileInfo("a.md", "# A\n\nBody two, edited.\n"));
    expect(c1[0].nodeKey).toBe(c2[0].nodeKey);
    expect(c1[0].contentHash).not.toBe(c2[0].contentHash);
  });

  it("line ranges track content", () => {
    const chunks = new Chunker().chunk(
      fileInfo("a.md", "# A\n\nBody one.\n\nBody two.")
    );
    expect(chunks[0].lineStart).toBe(2);
    expect(chunks[0].lineEnd).toBe(5);
  });
});

describe("FixtureGolden", () => {
  it("fixture sections match golden", () => {
    const files = new Scanner(FIXTURE_VAULT_DIR)
      .scan()
      .filter(f => path.basename(f.path) !== "_manifest.md");
    const chunker = new Chunker();
    const got: Record<string, unknown> = {};
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      got[f.path] = chunker.chunk(f).map(sectionShape);
    }
    expect(got).toEqual(golden("chunker_sections.json"));
  });
});
