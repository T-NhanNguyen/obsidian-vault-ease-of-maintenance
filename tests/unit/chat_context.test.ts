// chat_context tests — context assembly, answer reconstruction, and the
// citation tracker that the cite_source tool drives at query time.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildChatContext,
  reconstructAnswer,
} from "../../src/agent/chat_context";
import {
  citeSource,
  resetCitationTracker,
  getCitationMap,
} from "../../src/agent/tools";
import type { ChatQueryResult } from "../../src/types";

function makeResult(overrides: Partial<ChatQueryResult> = {}): ChatQueryResult {
  return {
    node_key: "n",
    file_path: "a.md",
    heading_path: "",
    score: 1,
    text: "body text",
    line_start: 0,
    line_end: 2,
    ...overrides,
  };
}

describe("buildChatContext", () => {
  it("numbers sources [1]..[n] in result order", () => {
    const ctx = buildChatContext([
      makeResult({ file_path: "a.md" }),
      makeResult({ file_path: "b.md" }),
      makeResult({ file_path: "c.md" }),
    ]);
    expect(ctx).toMatch(/^\[1\] a\.md/);
    expect(ctx).toContain("[2] b.md");
    expect(ctx).toContain("[3] c.md");
  });

  it("includes heading and line range for provenance", () => {
    const ctx = buildChatContext([makeResult({ heading_path: "Section", line_start: 4, line_end: 9 })]);
    expect(ctx).toContain("a.md — Section (lines 4-9)");
    expect(ctx).toContain("body text");
  });

  it("returns an empty string when there are no results", () => {
    expect(buildChatContext([])).toBe("");
  });
});

describe("reconstructAnswer", () => {
  it("joins all assistant content fragments", () => {
    const answer = reconstructAnswer([
      { role: "assistant", content: "First claim." },
      { role: "tool", content: "[1]" },
      { role: "assistant", content: " Second claim." },
    ]);
    expect(answer).toBe("First claim. Second claim.");
  });

  it("skips messages that are not assistant or have no content", () => {
    const answer = reconstructAnswer([
      { role: "system", content: "Be helpful." },
      { role: "assistant", content: null },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Hello." },
    ]);
    expect(answer).toBe("Hello.");
  });

  it("returns a fallback message when nothing was produced", () => {
    expect(reconstructAnswer([])).toBe("[The agent produced no answer text.]");
  });
});

describe("citeSource tracker", () => {
  beforeEach(() => {
    resetCitationTracker();
  });

  it("returns [1] for the first source, [2] for the next distinct source", () => {
    expect(citeSource({ source_id: 1 })).toBe("[1]");
    expect(citeSource({ source_id: 2 })).toBe("[2]");
    expect(citeSource({ source_id: 3 })).toBe("[3]");
  });

  it("returns the same number on repeated citations of the same source", () => {
    expect(citeSource({ source_id: 2 })).toBe("[1]");
    expect(citeSource({ source_id: 2 })).toBe("[1]");
    expect(citeSource({ source_id: 1 })).toBe("[2]");
    expect(citeSource({ source_id: 2 })).toBe("[1]");
  });

  it("rejects invalid source_id values", () => {
    expect(citeSource({ source_id: 0 })).toContain("Error");
    expect(citeSource({ source_id: -1 })).toContain("Error");
    expect(citeSource({ source_id: NaN })).toContain("Error");
  });

  it("resetCitationTracker clears the counter and map", () => {
    citeSource({ source_id: 1 });
    citeSource({ source_id: 2 });
    expect(citeSource({ source_id: 1 })).toBe("[1]");
    resetCitationTracker();
    expect(citeSource({ source_id: 1 })).toBe("[1]");
    expect(citeSource({ source_id: 2 })).toBe("[2]");
    expect(getCitationMap()).toEqual({ 1: 0, 2: 1 });
  });
});

describe("getCitationMap", () => {
  beforeEach(() => resetCitationTracker());

  it("builds a citation-number → source-index map", () => {
    citeSource({ source_id: 3 }); // returns [1], source-index 2
    citeSource({ source_id: 1 }); // returns [2], source-index 0
    expect(getCitationMap()).toEqual({ 1: 2, 2: 0 });
  });

  it("returns an empty object when nothing has been cited", () => {
    expect(getCitationMap()).toEqual({});
  });
});
