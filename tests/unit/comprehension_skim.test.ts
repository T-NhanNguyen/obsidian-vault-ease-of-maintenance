// Batch-skim sampler tests — sampling math (adaptive budget, per-file cap,
// proportional stratification), note classification (root/MOC/regular),
// frontmatter/outline/word-count extraction, ignore patterns, pathFilter,
// the mtime cache, and directory summaries.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  sampleVault,
  parseFrontmatter,
  extractTags,
  isMocNote,
  countWords,
  firstWords,
  headingOutline,
  OUTLINE_CAP,
  type SkimOptions,
  type SkimReport,
} from "../../src/comprehension/skim";

const tempDirs: string[] = [];

function makeVault(files: Record<string, string>): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-skim-"));
  tempDirs.push(vault);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return vault;
}

function defaultOptions(overrides: Partial<SkimOptions> = {}): SkimOptions {
  return {
    tokenBudget: 100,
    rootExcerptWords: 100,
    mocExcerptWords: 100,
    regularExcerptWords: 40,
    sampleTargetFiles: 5,
    ignorePatterns: [],
    ...overrides,
  };
}

const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";

function note(pathKey: string, words: number = 10): string {
  const body = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  return `# ${pathKey}\n\n${body}\n`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skim — word counting and excerpts", () => {
  it("counts whitespace-delimited words", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  spaced   out  ")).toBe(2);
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });

  it("slices the first N words", () => {
    expect(firstWords(WORDS, 3)).toBe("alpha beta gamma");
    expect(firstWords("short", 100)).toBe("short");
    expect(firstWords(WORDS, 0)).toBe("");
  });
});

describe("skim — frontmatter", () => {
  it("parses inline list tags and a type field", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\ntags: [alpha, beta]\ntype: MOC\n---\nbody text",
    );
    expect(frontmatter).toEqual({ tags: ["alpha", "beta"], type: "MOC" });
    expect(body).toBe("body text");
  });

  it("parses comma-separated string tags", () => {
    const { frontmatter } = parseFrontmatter("---\ntags: alpha, beta\n---\nbody");
    expect(extractTags(frontmatter)).toEqual(["alpha", "beta"]);
  });

  it("parses indented list tags", () => {
    const { frontmatter } = parseFrontmatter("---\ntags:\n  - one\n  - two\n---\nbody");
    expect(extractTags(frontmatter)).toEqual(["one", "two"]);
  });

  it("returns null frontmatter when absent", () => {
    const { frontmatter, body } = parseFrontmatter("plain body");
    expect(frontmatter).toBeNull();
    expect(body).toBe("plain body");
  });

  it("handles numbers, booleans, and quoted strings", () => {
    const { frontmatter } = parseFrontmatter(
      '---\ncount: 42\nactive: true\ntitle: "My Note"\n---\nbody',
    );
    expect(frontmatter).toEqual({ count: 42, active: true, title: "My Note" });
  });
});

describe("skim — classification", () => {
  it("detects MOC notes by filename, type frontmatter, and tag", () => {
    expect(isMocNote("moc-index", null, [])).toBe(true);
    expect(isMocNote("notes", { type: "MOC" }, [])).toBe(true);
    expect(isMocNote("notes", null, ["moc"])).toBe(true);
    expect(isMocNote("notes", null, [])).toBe(false);
  });

  it("classifies root, moc, and regular notes in a sample", () => {
    const vault = makeVault({
      "README.md": note("README"),
      "index-moc.md": note("index-moc"),
      "a/one.md": note("one"),
      "a/two.md": note("two"),
    });
    const report = sampleVault({ vaultPath: vault, options: defaultOptions() });
    const byPath = new Map(report.notes.map((n) => [n.path, n.kind]));
    expect(byPath.get("README.md")).toBe("root");
    expect(byPath.get("index-moc.md")).toBe("moc");
    expect(byPath.get("a/one.md")).toBe("regular");
  });
});

describe("skim — sampling math", () => {
  it("gives root/MOC full excerpts and shares the budget among sampled regular notes", () => {
    // note(key, n) = "# key\n\n" + n words → 1 + 1 + n words total, so the
    // 98-word notes excerpt to exactly 100 words and the 18-word notes to 20.
    const vault = makeVault({
      "README.md": note("README", 98),
      "moc.md": note("moc", 98),
      "a/a1.md": note("a1", 18),
      "a/a2.md": note("a2", 18),
      "a/a3.md": note("a3", 18),
      "b/b1.md": note("b1", 18),
      "b/b2.md": note("b2", 18),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ tokenBudget: 100, sampleTargetFiles: 5, regularExcerptWords: 40 }),
    });
    const readme = report.notes.find((n) => n.path === "README.md")!;
    const moc = report.notes.find((n) => n.path === "moc.md")!;
    expect(readme.excerpt.split(" ").length).toBe(100);
    expect(moc.excerpt.split(" ").length).toBe(100);
    // 5 regular files share 100 words → 20 words each (≤ 40 cap).
    expect(report.parameters.perFileBudget).toBe(20);
    const regular = report.notes.filter((n) => n.kind === "regular");
    expect(regular).toHaveLength(5);
    expect(regular.every((n) => n.sampled)).toBe(true);
    expect(regular.every((n) => n.excerpt.split(" ").length === 20)).toBe(true);
    expect(report.totalWords).toBe(100 + 100 + 20 * 5);
  });

  it("caps the per-file budget at regularExcerptWords", () => {
    const vault = makeVault({
      "a/a1.md": note("a1"),
      "a/a2.md": note("a2"),
      "b/b1.md": note("b1"),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ tokenBudget: 1000, sampleTargetFiles: 5 }),
    });
    expect(report.parameters.perFileBudget).toBe(40);
  });

  it("floors the per-file budget at 1 word", () => {
    const vault = makeVault({
      "a/a1.md": note("a1"),
      "a/a2.md": note("a2"),
      "b/b1.md": note("b1"),
      "b/b2.md": note("b2"),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ tokenBudget: 2, sampleTargetFiles: 5 }),
    });
    expect(report.parameters.perFileBudget).toBe(1);
  });

  it("samples proportionally across top-level folders", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`a/f${i}.md`] = note(`f${i}`);
    for (let i = 0; i < 4; i++) files[`b/f${i}.md`] = note(`f${i}`);
    const vault = makeVault(files);
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 5, tokenBudget: 1000 }),
    });
    const sampledA = report.notes.filter((n) => n.path.startsWith("a/") && n.sampled).length;
    const sampledB = report.notes.filter((n) => n.path.startsWith("b/") && n.sampled).length;
    expect(sampledA).toBe(3);
    expect(sampledB).toBe(2);
  });

  it("is deterministic — two runs emit identical notes and summaries", () => {
    const vault = makeVault({
      "README.md": note("README"),
      "a/a1.md": note("a1"),
      "a/a2.md": note("a2"),
      "a/a3.md": note("a3"),
      "b/b1.md": note("b1"),
      "b/b2.md": note("b2"),
    });
    const first = sampleVault({ vaultPath: vault, options: defaultOptions() });
    const second = sampleVault({ vaultPath: vault, options: defaultOptions() });
    expect(second.notes).toEqual(first.notes);
    expect(second.directories).toEqual(first.directories);
    expect(second.parameters).toEqual(first.parameters);
  });
});

describe("skim — ignore patterns and filters", () => {
  it("skips hidden dirs and ignored folders", () => {
    const vault = makeVault({
      ".hidden/h.md": note("h"),
      "drafts/d.md": note("d"),
      "a/one.md": note("one"),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ ignorePatterns: ["drafts/"] }),
    });
    expect(report.notes.map((n) => n.path)).toEqual(["a/one.md"]);
  });

  it("restricts to a subtree via pathFilter", () => {
    const vault = makeVault({
      "a/one.md": note("one"),
      "a/two.md": note("two"),
      "b/three.md": note("three"),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 10 }),
      pathFilter: "a/",
    });
    expect(report.notes.map((n) => n.path).sort()).toEqual(["a/one.md", "a/two.md"]);
  });

  it("returns an empty report for a missing vault", () => {
    const report = sampleVault({
      vaultPath: path.join(os.tmpdir(), "nm-skim-missing-" + Date.now()),
      options: defaultOptions(),
    });
    expect(report.notes).toEqual([]);
    expect(report.directories).toEqual([]);
  });
});

describe("skim — mtime cache", () => {
  it("reuses cached entries on an unchanged re-run and re-derives changed files", () => {
    const vault = makeVault({
      "a/a1.md": note("a1"),
      "a/a2.md": note("a2"),
      "b/b1.md": note("b1"),
    });
    const cachePath = ".note-maintainer/comprehension-skim-cache.json";
    const options = defaultOptions({ sampleTargetFiles: 10 });
    const first = sampleVault({ vaultPath: vault, options, cachePath });
    expect(first.cacheHits).toBe(0);

    // Change a2 (new mtime + content); a1 and b1 stay untouched.
    fs.writeFileSync(path.join(vault, "a/a2.md"), note("a2-changed"), "utf-8");

    const second = sampleVault({ vaultPath: vault, options, cachePath });
    expect(second.cacheHits).toBeGreaterThan(0);
    const changed = second.notes.find((n) => n.path === "a/a2.md")!;
    expect(changed.excerpt).toContain("a2-changed");
    const unchanged = second.notes.find((n) => n.path === "a/a1.md")!;
    expect(unchanged.excerpt).toBe(first.notes.find((n) => n.path === "a/a1.md")!.excerpt);
  });

  it("ignores a corrupt cache and samples fresh", () => {
    const vault = makeVault({
      "a/a1.md": note("a1"),
      "a/a2.md": note("a2"),
    });
    const cachePath = ".note-maintainer/comprehension-skim-cache.json";
    fs.mkdirSync(path.join(vault, ".note-maintainer"), { recursive: true });
    fs.writeFileSync(path.join(vault, cachePath), "{ not json", "utf-8");
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 10 }),
      cachePath,
    });
    expect(report.notes).toHaveLength(2);
    expect(report.cacheHits).toBe(0);
  });
});

describe("skim — report shape", () => {
  it("emits heading outlines capped at OUTLINE_CAP", () => {
    const body = Array.from({ length: 40 }, (_, i) => `## Heading ${i}`).join("\n");
    expect(headingOutline(body)).toHaveLength(OUTLINE_CAP);

    const vault = makeVault({ "a/one.md": body });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 10 }),
    });
    const one = report.notes.find((n) => n.path === "a/one.md")!;
    expect(one.outline).toHaveLength(OUTLINE_CAP);
    expect(one.outline[0]).toBe("## Heading 0");
  });

  it("includes directory summaries for every top-level folder with tags", () => {
    const vault = makeVault({
      "README.md": note("README"),
      "a/a1.md": "---\ntags: [alpha]\n---\n" + note("a1"),
      "a/a2.md": "---\ntags: [alpha, beta]\n---\n" + note("a2"),
      "b/b1.md": "---\ntags: [gamma]\n---\n" + note("b1"),
    });
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 10 }),
    });
    const byDir = new Map(report.directories.map((d) => [d.path, d]));
    expect(byDir.get("a")!.fileCount).toBe(2);
    expect(byDir.get("a")!.dominantTags).toEqual([
      { tag: "alpha", count: 2 },
      { tag: "beta", count: 1 },
    ]);
    expect(byDir.get("b")!.dominantTags).toEqual([{ tag: "gamma", count: 1 }]);
    expect(byDir.get("")!.fileCount).toBe(1);
  });

  it("marks unsampled regular notes with empty excerpts and no outline", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`a/f${String(i).padStart(2, "0")}.md`] = note(`f${i}`);
    const vault = makeVault(files);
    const report = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ sampleTargetFiles: 5 }),
    });
    const unsampled = report.notes.filter((n) => !n.sampled);
    expect(unsampled.length).toBeGreaterThan(0);
    expect(unsampled.every((n) => n.excerpt === "" && n.outline.length === 0)).toBe(true);
    // The directory summary still counts all files.
    expect(report.directories[0].fileCount).toBe(20);
  });
});

describe("skim — report determinism helper", () => {
  it("logs the parameters actually used", () => {
    const vault = makeVault({ "a/a1.md": note("a1") });
    const report: SkimReport = sampleVault({
      vaultPath: vault,
      options: defaultOptions({ tokenBudget: 50, sampleTargetFiles: 3 }),
    });
    expect(report.parameters).toMatchObject({
      tokenBudget: 50,
      perFileBudget: 40,
      sampledRegularCount: 1,
    });
  });
});
