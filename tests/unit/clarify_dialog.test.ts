// Portable clarification dialog tests (handoff Part A) — the module sort and
// build-index will share. Pins the whole flow: read the manifest from disk →
// detect uncovered folders → bounded Q&A → apply_edits ops at the correct
// heading depth → diff → the guarded write. Every expectation is
// hand-computable; the placement and LCS-diff behaviors are pinned exactly.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TocReader } from "../../src/indexer/manifest";
import {
  scanVaultFolders,
  computeUncoveredFolders,
  runClarifyDialog,
  buildManifestOps,
  lineDiff,
  parseFolderPurposes,
  writeClarifyProposal,
  MANIFEST_H1,
  type ClarifyAnswer,
  type ClarifyProposal,
  type ClarifyQuestion,
} from "../../src/agent/clarify";

const GENERATED_H1 = "# vault <!-- Auto-generated from GraphRAG index — review and edit -->";

function makeVault(folders: Record<string, string[]>): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-clarify-"));
  for (const [folder, files] of Object.entries(folders)) {
    const abs = path.join(vaultDir, folder);
    fs.mkdirSync(abs, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(abs, file), `# ${file}\n`, "utf-8");
  }
  return vaultDir;
}

function writeManifest(vaultDir: string, content: string, name = "_manifest.md"): string {
  fs.writeFileSync(path.join(vaultDir, name), content, "utf-8");
  return name;
}

function parsedEntries(content: string) {
  return new TocReader("")._parseContent(content);
}

function scriptedAsker(purposes: Record<string, string>) {
  const asked: string[] = [];
  const ask = async (question: ClarifyQuestion): Promise<string | null> => {
    asked.push(question.folderPath);
    return purposes[question.folderPath] ?? null;
  };
  return { ask, asked };
}

// ---------------------------------------------------------------------------
// Vault scan
// ---------------------------------------------------------------------------

describe("scanVaultFolders", () => {
  it("lists folders with direct markdown files, skipping hidden and ignored dirs", () => {
    const vault = makeVault({
      "10_Stocks": ["IREN.md", "Bloom_Energy.md"],
      "10_Stocks/Bloom_Energy": ["report.md"],
      "10_Stocks/Bloom_Energy/deep": ["extra.md"],
      "20_AI": ["idea.md"],
      ".hidden": ["secret.md"],
      "ignored_dir": ["skip.md"],
    });

    const folders = scanVaultFolders(vault, ["ignored_dir"]);
    expect(folders).toEqual([
      { path: "10_Stocks", files: ["Bloom_Energy.md", "IREN.md"] },
      { path: "10_Stocks/Bloom_Energy", files: ["report.md"] },
      { path: "10_Stocks/Bloom_Energy/deep", files: ["extra.md"] },
      { path: "20_AI", files: ["idea.md"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Uncovered-folder detection
// ---------------------------------------------------------------------------

describe("computeUncoveredFolders", () => {
  it("returns only the folders the manifest does not cover", () => {
    const manifest =
      "# vault\n" +
      "## 10_Stocks/ <!-- stock research -->\n" +
      "     10_Stocks/IREN.md\n";
    const folders = [
      { path: "10_Stocks", files: ["IREN.md"] },
      { path: "20_AI_Speculations", files: ["idea.md"] },
    ];

    const uncovered = computeUncoveredFolders(parsedEntries(manifest), folders);
    expect(uncovered.map(f => f.path)).toEqual(["20_AI_Speculations"]);
  });

  it("bare child names in a hand-written manifest still cover the full path", () => {
    const manifest =
      "# vault\n" +
      "## 10_Stocks/ <!-- stock research -->\n" +
      "### Bloom_Energy <!-- clean energy -->\n";
    const folders = [{ path: "10_Stocks/Bloom_Energy", files: ["report.md"] }];

    const uncovered = computeUncoveredFolders(parsedEntries(manifest), folders);
    expect(uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dialog runner
// ---------------------------------------------------------------------------

describe("runClarifyDialog", () => {
  it("asks about uncovered folders and proposes correct-depth entries", async () => {
    const vault = makeVault({
      "10_Stocks": ["IREN.md"],
      "10_Stocks/Bloom_Energy": ["report.md"],
      "20_AI_Speculations": ["idea.md"],
    });
    const manifestPath = writeManifest(
      vault,
      GENERATED_H1 + "\n" +
      "## 10_Stocks/ <!-- stock research -->\n" +
      "     10_Stocks/IREN.md\n",
    );
    const { ask, asked } = scriptedAsker({
      "20_AI_Speculations": "AI speculation",
      "10_Stocks/Bloom_Energy": "clean energy",
    });

    const proposal = await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask,
    });

    // Lexicographic order: the nested folder (parent 10_Stocks is covered)
    // comes before its top-level sibling 20_AI.
    expect(asked).toEqual(["10_Stocks/Bloom_Energy", "20_AI_Speculations"]);
    expect(proposal).not.toBeNull();
    const p = proposal!;
    expect(p.manifestPath).toBe("_manifest.md");
    expect(p.answered.map(a => a.question.folderPath)).toEqual([
      "10_Stocks/Bloom_Energy",
      "20_AI_Speculations",
    ]);
    expect(p.unanswered).toEqual([]);

    // Ops: insert_header at the correct depths and anchors, emitted in
    // (before_line, path) order — 20_AI above the block, Bloom after it.
    expect(p.ops).toEqual([
      { op: "insert_header", anchor: { before_line: 2 }, text: "## 20_AI_Speculations/ <!-- AI speculation -->" },
      { op: "insert_header", anchor: { before_line: 5 }, text: "### 10_Stocks/Bloom_Energy/ <!-- clean energy -->" },
    ]);

    // Untouched sections stay byte-identical; new entries land at depth.
    // The trailing newline is normalized (POSIX convention, as generateManifest).
    expect(p.after).toBe(
      GENERATED_H1 + "\n" +
      "## 20_AI_Speculations/ <!-- AI speculation -->\n" +
      "## 10_Stocks/ <!-- stock research -->\n" +
      "     10_Stocks/IREN.md\n" +
      "\n" +
      "### 10_Stocks/Bloom_Energy/ <!-- clean energy -->\n",
    );

    // The diff is hand-computable (LCS with >= tie-breaking). The final "+"
    // line is the restored trailing newline.
    expect(p.diff).toBe(
      " " + GENERATED_H1 + "\n" +
      "+## 20_AI_Speculations/ <!-- AI speculation -->\n" +
      " ## 10_Stocks/ <!-- stock research -->\n" +
      "      10_Stocks/IREN.md\n" +
      " \n" +
      "+### 10_Stocks/Bloom_Energy/ <!-- clean energy -->\n" +
      "+",
    );

    // Reparse round trip: every answered purpose is present.
    const purposes = parseFolderPurposes(p.after);
    expect(purposes.get("20_AI_Speculations")).toBe("AI speculation");
    expect(purposes.get("10_Stocks/Bloom_Energy")).toBe("clean energy");
    expect(purposes.get("10_Stocks")).toBe("stock research");
  });

  it("second run proposes nothing — answered purposes live in the manifest", async () => {
    const vault = makeVault({
      "10_Stocks": ["IREN.md"],
      "10_Stocks/Bloom_Energy": ["report.md"],
      "20_AI_Speculations": ["idea.md"],
    });
    const manifestPath = writeManifest(vault, GENERATED_H1 + "\n");
    const first = await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask: scriptedAsker({
        "10_Stocks": "stocks",
        "20_AI_Speculations": "ai",
        "10_Stocks/Bloom_Energy": "energy",
      }).ask,
    });
    expect(first).not.toBeNull();
    writeClarifyProposal(vault, manifestPath, first!);

    const again = await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask: scriptedAsker({}).ask,
    });
    expect(again).toBeNull();
  });

  it("a null answer stops the dialog and leaves the remaining folders unanswered", async () => {
    const vault = makeVault({
      "10_Stocks": ["a.md"],
      "20_AI_Speculations": ["b.md"],
      "10_Stocks/Bloom_Energy": ["c.md"],
    });
    const manifestPath = writeManifest(vault, GENERATED_H1 + "\n");
    const { ask, asked } = scriptedAsker({ "10_Stocks": "stocks" });
    // The asker answers 10_Stocks, then declines the next folder (deadline/skip).
    let calls = 0;
    const boundedAsk = async (question: ClarifyQuestion): Promise<string | null> => {
      calls += 1;
      if (calls === 2) return null;
      return ask(question);
    };

    const proposal = await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask: boundedAsk,
    });

    // The second folder was asked (and declined); the third was never asked.
    expect(calls).toBe(2);
    expect(asked).toEqual(["10_Stocks"]);
    expect(proposal).not.toBeNull();
    expect(proposal!.answered.map(a => a.question.folderPath)).toEqual(["10_Stocks"]);
    // The declined folder AND the never-asked one are both left uncovered.
    expect(proposal!.unanswered).toEqual(["10_Stocks/Bloom_Energy", "20_AI_Speculations"]);
  });

  it("creates a brand-new manifest when none exists on disk", async () => {
    const vault = makeVault({
      "Projects": ["p.md"],
      "Inbox": ["i.md"],
    });
    const proposal = await runClarifyDialog({
      vaultPath: vault,
      manifestPath: null,
      folders: scanVaultFolders(vault, []),
      ask: scriptedAsker({
        "Inbox": "inbox",
        "Projects": "active work",
      }).ask,
    });

    expect(proposal).not.toBeNull();
    expect(proposal!.manifestPath).toBeNull();
    expect(proposal!.before).toBe("");
    expect(proposal!.after).toBe(
      MANIFEST_H1 + "\n" +
      "## Inbox/ <!-- inbox -->\n" +
      "## Projects/ <!-- active work -->\n",
    );
  });

  it("sanitizes answers before they become purposes", async () => {
    const vault = makeVault({ "X": ["a.md"] });
    const manifestPath = writeManifest(vault, GENERATED_H1 + "\n");
    const proposal = await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask: async () => "reference --> material<!-- notes",
    });

    expect(proposal!.after).toContain("## X/ <!-- reference material notes -->");
  });
});

// ---------------------------------------------------------------------------
// Placement — insertion right after the parent block
// ---------------------------------------------------------------------------

describe("buildManifestOps placement", () => {
  it("inserts a nested entry after its parent's block, before the next heading", () => {
    const before =
      "# vault\n" +
      "## 10_Stocks/ <!-- stocks -->\n" +
      "     10_Stocks/IREN.md\n" +
      "## 20_AI/ <!-- ai -->\n";
    const answered: ClarifyAnswer[] = [
      {
        question: { folderPath: "10_Stocks/Bloom_Energy", prompt: "" },
        answer: "clean energy",
      },
    ];

    const ops = buildManifestOps(before, answered);
    expect(ops).toEqual([
      { op: "insert_header", anchor: { before_line: 4 }, text: "### 10_Stocks/Bloom_Energy/ <!-- clean energy -->" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The guarded write
// ---------------------------------------------------------------------------

describe("writeClarifyProposal", () => {
  it("writes atomically and round-trips through the parser", async () => {
    const vault = makeVault({ "Inbox": ["i.md"] });
    const manifestPath = writeManifest(vault, GENERATED_H1 + "\n");
    const proposal = (await runClarifyDialog({
      vaultPath: vault,
      manifestPath,
      folders: scanVaultFolders(vault, []),
      ask: async () => "inbox",
    }))!;

    writeClarifyProposal(vault, manifestPath, proposal);

    const written = fs.readFileSync(path.join(vault, manifestPath), "utf-8");
    expect(written).toBe(proposal.after);
    expect(parseFolderPurposes(written).get("Inbox")).toBe("inbox");
    expect(fs.readdirSync(vault).filter(name => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("throws when the content does not reparse to the answered purposes", () => {
    const vault = makeVault({});
    const bad: ClarifyProposal = {
      manifestPath: "_manifest.md",
      before: "# vault\n",
      after: "# vault\n",
      ops: [],
      answered: [
        { question: { folderPath: "X", prompt: "" }, answer: "purpose" },
      ],
      unanswered: [],
      diff: "",
    };
    expect(() => writeClarifyProposal(vault, "_manifest.md", bad)).toThrow(
      /Manifest round-trip failed for X/,
    );
  });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe("lineDiff", () => {
  it("renders a hand-computable unified diff", () => {
    // LCS of [a, b] vs [a, x, b] is [a, b]; the interior insertion surfaces
    // as a single + line, not a remove/re-add of b.
    expect(lineDiff("a\nb", "a\nx\nb")).toBe(" a\n+x\n b");
    expect(lineDiff("", "x\ny")).toBe("+x\n+y");
    expect(lineDiff("x\ny", "")).toBe("-x\n-y");
    expect(lineDiff("same", "same")).toBe(" same");
  });
});
