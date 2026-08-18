// apply_edits tool-call path tests — handoff [TEST-01..05].
//
// The dispatch-shape regression: LLM tool args arrive as ONE parsed JSON
// object; Tool.call passes it whole to the fn. applyEdits(handle, ops) used
// to receive handle=<object>, ops=undefined and always error via reg.resolve.
// These tests pin the args-object contract, the error containment, the
// per-op edit matrix, and the snake_case receipt wire format.
//
// Tool.call is async (tools may await embeddings/HTTP), so every assertion
// awaits the result.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Tool } from "../../src/agent/llm";
import {
  APPLY_EDITS_TOOL,
  CITE_SOURCE_TOOL,
  CLARIFY_TOOL,
  applyEdits,
  citeSource,
  clarify,
  setClarifyAnswerProvider,
  resetClarifyAnswerProvider,
  resetCitationTracker,
} from "../../src/agent/tools";
import { updateSettings, defaultSettings } from "../../src/config";
import { DatabaseManager } from "../../src/indexer/db";
import { makeToolVault, tmpFilesIn } from "../fixtures/tool_helpers";

const BASE_NOTE = [
  "# Title",
  "",
  "First paragraph line one.",
  "Second paragraph line one.",
  "",
  "",
  "Third paragraph line one.",
].join("\n");

function applyEditsTool(): Tool {
  return new Tool(
    APPLY_EDITS_TOOL.name,
    APPLY_EDITS_TOOL.description,
    APPLY_EDITS_TOOL.parameters,
    applyEdits,
  );
}

afterAll(() => {
  updateSettings(defaultSettings());
});

describe("apply_edits dispatch shape (TEST-01)", () => {
  it("Tool.call receives the whole args object and returns a receipt with receipt_id", async () => {
    const vault = makeToolVault(BASE_NOTE);
    const result = await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "join_lines", anchor: { start: 3, end: 4 } }],
    });
    const receipt = JSON.parse(result) as {
      receipt_id: string;
      ops_applied: number;
      validation: { passed: boolean };
    };
    expect(receipt.receipt_id).toMatch(/^r_\d{4}$/);
    expect(receipt.ops_applied).toBe(1);
    expect(fs.readFileSync(vault.notePath, "utf-8")).toBe(
      [
        "# Title",
        "",
        "First paragraph line one. Second paragraph line one.",
        "",
        "",
        "Third paragraph line one.",
      ].join("\n")
    );
    expect(tmpFilesIn(vault.vaultDir)).toEqual([]);
  });

  it("receipt wire format is snake_case (receipt_id, hash_before, ops_applied)", async () => {
    const vault = makeToolVault(BASE_NOTE);
    const result = await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "join_lines", anchor: { start: 3, end: 4 } }],
    });
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.receipt_id).toBeDefined();
    expect(parsed.hash_before).toBeDefined();
    expect(parsed.hash_after).toBeDefined();
    expect(parsed.ops_applied).toBeDefined();
    expect(parsed.ops_rejected).toBeDefined();
    expect(parsed.diff_stat).toBeDefined();
    expect(parsed.validation).toBeDefined();
  });
});

describe("Tool.call error containment (TEST-02)", () => {
  it("surfaces thrown errors as 'Error: <message>'", async () => {
    const tool = new Tool("boom", "d", {}, () => {
      throw new Error("kaboom");
    });
    await expect(tool.call({})).resolves.toBe("Error: kaboom");
  });

  it("maps null and undefined results to (empty)", async () => {
    const nullTool = new Tool(
      "null",
      "d",
      {},
      (() => null) as unknown as (args: Record<string, unknown>) => string,
    );
    await expect(nullTool.call({})).resolves.toBe("(empty)");

    const undefTool = new Tool(
      "undef",
      "d",
      {},
      (() => undefined) as unknown as (args: Record<string, unknown>) => string,
    );
    await expect(undefTool.call({})).resolves.toBe("(empty)");
  });
});

describe("cite_source through Tool.call (TEST-03)", () => {
  it("returns [n] markers through the dispatch path", async () => {
    resetCitationTracker();
    const tool = new Tool(
      CITE_SOURCE_TOOL.name,
      CITE_SOURCE_TOOL.description,
      CITE_SOURCE_TOOL.parameters,
      citeSource,
    );
    await expect(tool.call({ source_id: 1 })).resolves.toBe("[1]");
    await expect(tool.call({ source_id: 2 })).resolves.toBe("[2]");
    await expect(tool.call({ source_id: 1 })).resolves.toBe("[1]");
  });

  it("rejects invalid source_id values", async () => {
    resetCitationTracker();
    const tool = new Tool(
      CITE_SOURCE_TOOL.name,
      CITE_SOURCE_TOOL.description,
      CITE_SOURCE_TOOL.parameters,
      citeSource,
    );
    // 0, negative, NaN, and absent ids are all invalid — the raw-function
    // cases were merged here from chat_context.test.ts (single DRY home for
    // the invalid-id guard, exercised through the dispatch path).
    await expect(tool.call({ source_id: 0 })).resolves.toContain("Error");
    await expect(tool.call({ source_id: -1 })).resolves.toContain("Error");
    await expect(tool.call({ source_id: NaN })).resolves.toContain("Error");
    await expect(tool.call({})).resolves.toContain("Error");
  });
});

describe("apply_edits per-op matrix (TEST-04)", () => {
  it("join_lines merges a range into one line", async () => {
    const vault = makeToolVault(BASE_NOTE);
    await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "join_lines", anchor: { start: 3, end: 4 } }],
    });
    const written = fs.readFileSync(vault.notePath, "utf-8");
    expect(written).toContain("First paragraph line one. Second paragraph line one.");
    expect(written).not.toContain("First paragraph line one.\nSecond");
  });

  it("insert_header inserts text before a line", async () => {
    const vault = makeToolVault(BASE_NOTE);
    await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "insert_header", anchor: { before_line: 3 }, text: "# New Section" }],
    });
    const written = fs.readFileSync(vault.notePath, "utf-8");
    expect(written).toContain("# New Section\nFirst paragraph line one.");
  });

  it("remove_span removes a tagged range", async () => {
    const vault = makeToolVault(BASE_NOTE);
    await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "remove_span", kind: "tag", anchor: { start: 3, end: 4 } }],
    });
    const written = fs.readFileSync(vault.notePath, "utf-8");
    expect(written).not.toContain("First paragraph line one.");
    expect(written).not.toContain("Second paragraph line one.");
    expect(written).toContain("Third paragraph line one.");
  });

  it("collapse_blanks keeps a single blank line", async () => {
    const vault = makeToolVault(BASE_NOTE);
    await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "collapse_blanks", anchor: { start: 5, end: 6 } }],
    });
    const written = fs.readFileSync(vault.notePath, "utf-8");
    expect(written).toBe(
      [
        "# Title",
        "",
        "First paragraph line one.",
        "Second paragraph line one.",
        "",
        "Third paragraph line one.",
      ].join("\n")
    );
  });

  it("insert_flag inserts a review comment", async () => {
    const vault = makeToolVault(BASE_NOTE);
    await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "insert_flag", anchor: { before_line: 3 }, reason: "needs review" }],
    });
    const written = fs.readFileSync(vault.notePath, "utf-8");
    expect(written).toContain("<!-- review: needs review -->\nFirst paragraph line one.");
  });

  it("returns ALL_OPS_REJECTED and leaves the file unchanged when every op is invalid", async () => {
    const vault = makeToolVault(BASE_NOTE);
    const result = await applyEditsTool().call({
      handle: vault.handle,
      ops: [{ op: "bogus_op", anchor: {} }],
    });
    const parsed = JSON.parse(result) as { error: string; file_unchanged: boolean };
    expect(parsed.error).toBe("ALL_OPS_REJECTED");
    expect(parsed.file_unchanged).toBe(true);
    expect(fs.readFileSync(vault.notePath, "utf-8")).toBe(BASE_NOTE);
    expect(tmpFilesIn(vault.vaultDir)).toEqual([]);
  });

  it("keeps the pre-existing NaN slice/splice behavior for missing anchors", async () => {
    const vault = makeToolVault(BASE_NOTE);
    const tool = applyEditsTool();

    // join_lines with no anchor: Number(undefined) - 1 = NaN, slice/splice
    // treat NaN as 0 → the op is a no-op on the file (do NOT "fix" to
    // 0-based indexing; pin the current semantics as a regression guard).
    const joinResult = await tool.call({ handle: vault.handle, ops: [{ op: "join_lines", anchor: {} }] });
    const joinReceipt = JSON.parse(joinResult) as { receipt_id: string };
    expect(joinReceipt.receipt_id).toMatch(/^r_\d{4}$/);
    expect(fs.readFileSync(vault.notePath, "utf-8")).toBe(BASE_NOTE);

    // insert_header with no before_line: splice(NaN, ...) inserts at index 0.
    const insertResult = await tool.call({
      handle: vault.handle,
      ops: [{ op: "insert_header", anchor: {}, text: "# Top" }],
    });
    const insertReceipt = JSON.parse(insertResult) as { receipt_id: string };
    expect(insertReceipt.receipt_id).toMatch(/^r_\d{4}$/);
    expect(fs.readFileSync(vault.notePath, "utf-8")).toBe("# Top\n" + BASE_NOTE);
  });
});

describe("getWikilinkEdges row casing (TEST-05)", () => {
  it("returns snake_case EdgeRow fields, not camelCase Edge casts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-db-"));
    const db = new DatabaseManager(path.join(tmpDir, "index.db"));
    await db.initialize();
    try {
      await db.insertEdges([{ srcKey: "f_0001", dstKey: "f_0002", kind: "wikilink", weight: 1 }]);
      const rows = await db.getWikilinkEdges("f_0001");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.src_key).toBe("f_0001");
      expect(row.dst_key).toBe("f_0002");
      expect(row.kind).toBe("wikilink");
      expect(row.weight).toBe(1);
      // The old `as Edge[]` cast mapped snake_case rows onto camelCase fields,
      // leaving srcKey undefined — pin that regression so it cannot return.
      expect(Object.prototype.hasOwnProperty.call(row, "srcKey")).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe("clarify tool (TEST-06)", () => {
  afterAll(() => {
    resetClarifyAnswerProvider();
  });

  it("rejects a missing or empty question", async () => {
    await expect(clarify({})).resolves.toBe("Error: question must be a non-empty string");
    await expect(clarify({ question: "   " })).resolves.toBe(
      "Error: question must be a non-empty string",
    );
  });

  it("returns the NO_ANSWER:<deadline> marker when no provider is registered", async () => {
    resetClarifyAnswerProvider();
    await expect(clarify({ question: "Where should this go?", deadline: "2030-01-01T00:00:00Z" }))
      .resolves.toBe("NO_ANSWER:2030-01-01T00:00:00Z");
    await expect(clarify({ question: "Where should this go?" }))
      .resolves.toBe("NO_ANSWER:unavailable");
  });

  it("passes the answer through verbatim from the provider", async () => {
    const seen: unknown[] = [];
    setClarifyAnswerProvider((args) => {
      seen.push(args);
      return "  under 10_Stocks  ";
    });
    const result = await clarify({
      question: "Where should this go?",
      options: ["a", "b"],
      context: "The vault has 3 folders.",
      deadline: "2030-01-01T00:00:00Z",
    });
    // Verbatim — the tool never trims or rewrites the answer.
    expect(result).toBe("  under 10_Stocks  ");
    expect(seen).toEqual([{
      question: "Where should this go?",
      options: ["a", "b"],
      context: "The vault has 3 folders.",
      deadline: "2030-01-01T00:00:00Z",
    }]);
  });

  it("turns a null provider answer into the NO_ANSWER marker", async () => {
    setClarifyAnswerProvider(() => null);
    await expect(clarify({ question: "q", deadline: "2030-01-01T00:00:00Z" }))
      .resolves.toBe("NO_ANSWER:2030-01-01T00:00:00Z");
  });

  it("never writes — a clarify call leaves the vault untouched", async () => {
    const vault = makeToolVault(BASE_NOTE);
    const before = fs.readdirSync(vault.vaultDir).sort();
    setClarifyAnswerProvider(() => "answer");
    await clarify({ question: "Where should this go?" });
    const after = fs.readdirSync(vault.vaultDir).sort();
    expect(after).toEqual(before);
    expect(tmpFilesIn(vault.vaultDir)).toEqual([]);
  });

  it("ships the wire schema with a required question", () => {
    expect(CLARIFY_TOOL.name).toBe("clarify");
    expect(CLARIFY_TOOL.parameters.required).toEqual(["question"]);
    expect(CLARIFY_TOOL.parameters.properties.deadline).toBeDefined();
  });
});
