// Comprehension state-machine tests — deterministic status evaluation
// (conflicted / insufficient_evidence / confirmed / low_confidence /
// needs_verification), the clarification triggers, contradiction detection,
// and durable phase/budget state.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeStatus,
  evaluateClarification,
  contradictingPairs,
  leadingEntries,
  ComprehensionState,
  BUDGET_WARN_FRACTION,
  type StateOptions,
  type ComprehensionStateData,
  type StatusResult,
} from "../../src/comprehension/state";
import { AssumptionLedger, type LedgerEntry } from "../../src/comprehension/ledger";

const tempDirs: string[] = [];

function makeStateOptions(overrides: Partial<StateOptions> = {}): StateOptions {
  return {
    toolCallBudget: 60,
    softThreshold: 0.7,
    confirmThreshold: 0.8,
    lowConfidenceThreshold: 0.4,
    minCoverage: 0.6,
    hotTopics: [],
    ...overrides,
  };
}

function entry(id: string, score: number, contradicts: string[] = []): LedgerEntry {
  const now = new Date().toISOString();
  return {
    id,
    assumption: `assumption ${id}`,
    score,
    evidence: [],
    contradicts,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

function evalStatus(
  entries: LedgerEntry[],
  coverage: number,
  verifyRounds: number,
  indexAvailable: boolean = true,
  opts: StateOptions = makeStateOptions(),
): StatusResult {
  return computeStatus(entries, opts, coverage, verifyRounds, indexAvailable);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("computeStatus — conflicted", () => {
  it("flags two hypotheses above the soft threshold that contradict", () => {
    const a = entry("a1", 0.9, []);
    const b = entry("a2", 0.85, ["a1"]);
    const result = evalStatus([a, b], 1, 1);
    expect(result.status).toBe("conflicted");
    expect(result.reason).toContain("a1");
    expect(result.reason).toContain("a2");
  });

  it("ignores contradiction pairs below the soft threshold", () => {
    const a = entry("a1", 0.5);
    const b = entry("a2", 0.5, ["a1"]);
    expect(evalStatus([a, b], 1, 1).status).not.toBe("conflicted");
  });

  it("detects contradiction pairs deterministically", () => {
    const a = entry("a1", 0.9, ["a2"]);
    const b = entry("a2", 0.9);
    expect(contradictingPairs([a, b], 0.7)).toEqual([{ a: "a1", b: "a2" }]);
    // Symmetric link does not duplicate the pair.
    const c = entry("a1", 0.9, ["a2"]);
    const d = entry("a2", 0.9, ["a1"]);
    expect(contradictingPairs([c, d], 0.7)).toEqual([{ a: "a1", b: "a2" }]);
  });
});

describe("computeStatus — insufficient_evidence", () => {
  it("flags low coverage below the minimum", () => {
    expect(evalStatus([entry("a1", 0.9)], 0.5, 1).status).toBe("insufficient_evidence");
  });

  it("flags a missing index once verification is attempted", () => {
    const result = evalStatus([entry("a1", 0.9)], 1, 1, false);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.reason).toContain("index");
  });

  it("does not flag a missing index before any verify round", () => {
    expect(evalStatus([entry("a1", 0.9)], 1, 0, false).status).not.toBe("insufficient_evidence");
  });

  it("flags an empty ledger", () => {
    const result = evalStatus([], 1, 0);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.reason).toContain("No assumptions");
  });
});

describe("computeStatus — confirmed / low_confidence / needs_verification", () => {
  it("confirms a verified, strong, uncontradicted hypothesis", () => {
    const result = evalStatus([entry("a1", 0.85)], 0.9, 2);
    expect(result.status).toBe("confirmed");
    expect(result.reason).toContain("Stop");
  });

  it("requires at least one verify round to confirm", () => {
    expect(evalStatus([entry("a1", 0.85)], 0.9, 0).status).toBe("needs_verification");
  });

  it("flags low_confidence after verification with a weak lead", () => {
    const result = evalStatus([entry("a1", 0.5)], 0.9, 1);
    expect(result.status).toBe("low_confidence");
    expect(result.reason).toContain("flag");
  });

  it("falls back to needs_verification before verification", () => {
    expect(evalStatus([entry("a1", 0.5)], 0.9, 0).status).toBe("needs_verification");
  });

  it("lists the leading hypotheses", () => {
    const a = entry("a1", 0.9);
    const b = entry("a2", 0.8);
    const c = entry("a3", 0.7);
    expect(leadingEntries([c, a, b], 2).map((e) => e.id)).toEqual(["a1", "a2"]);
  });
});

describe("evaluateClarification — triggers", () => {
  function state(partial: Partial<ComprehensionStateData> = {}): ComprehensionStateData {
    return {
      phase: "verify",
      status: "needs_verification",
      statusReason: "",
      toolCallsUsed: 0,
      toolCallBudget: 60,
      verifyRounds: 0,
      coverage: 0,
      hotTopicsHit: [],
      lastRunAt: null,
      complete: false,
      ...partial,
    };
  }

  it("fires MANDATORY on conflicted", () => {
    const decision = evaluateClarification(
      { status: "conflicted", reason: "conflict" },
      state(),
      makeStateOptions(),
      [],
    );
    expect(decision.action).toBe("mandatory");
    expect(decision.reason).toBe("conflicted");
  });

  it("fires MANDATORY on insufficient_evidence", () => {
    const decision = evaluateClarification(
      { status: "insufficient_evidence", reason: "coverage" },
      state(),
      makeStateOptions(),
      [],
    );
    expect(decision.action).toBe("mandatory");
  });

  it("defers insufficient_evidence mid-batch (defer flag) so the model can keep building evidence", () => {
    const decision = evaluateClarification(
      { status: "insufficient_evidence", reason: "coverage" },
      state(),
      makeStateOptions(),
      [],
      true,
    );
    expect(decision.action).toBe("none");
  });

  it("fires OPTIONAL when a hot-topic keyword hits a newly sampled path", () => {
    const decision = evaluateClarification(
      { status: "needs_verification", reason: "continue" },
      state({ toolCallsUsed: 5 }),
      makeStateOptions({ hotTopics: ["colmac"] }),
      ["colmac/project.md"],
    );
    expect(decision.action).toBe("optional");
    expect(decision.reason).toBe("hot_topic");
    expect(decision.detail).toContain("colmac");
  });

  it("does not fire hot_topic without newly sampled paths", () => {
    const decision = evaluateClarification(
      { status: "needs_verification", reason: "continue" },
      state(),
      makeStateOptions({ hotTopics: ["colmac"] }),
      [],
    );
    expect(decision.action).toBe("none");
  });

  it("fires MANDATORY when the budget is nearly exhausted and still needs_verification", () => {
    const used = Math.ceil(60 * BUDGET_WARN_FRACTION);
    const decision = evaluateClarification(
      { status: "needs_verification", reason: "continue" },
      state({ toolCallsUsed: used }),
      makeStateOptions(),
      [],
    );
    expect(decision.action).toBe("mandatory");
    expect(decision.reason).toBe("budget");
  });

  it("does not fire the budget trigger on confirmed", () => {
    const decision = evaluateClarification(
      { status: "confirmed", reason: "done" },
      state({ toolCallsUsed: 60 }),
      makeStateOptions(),
      [],
    );
    expect(decision.action).toBe("none");
  });

  it("stays silent when nothing fires", () => {
    const decision = evaluateClarification(
      { status: "needs_verification", reason: "continue" },
      state({ toolCallsUsed: 10 }),
      makeStateOptions({ hotTopics: ["colmac"] }),
      [],
    );
    expect(decision.action).toBe("none");
  });
});

describe("ComprehensionState — durable state", () => {
  it("resumes the phase and budget from a previous invocation", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    const first = new ComprehensionState(vault, undefined, makeStateOptions());
    first.update({ phase: "verify", toolCallsUsed: 12, verifyRounds: 1 });

    const second = new ComprehensionState(vault, undefined, makeStateOptions());
    const resumed = second.get();
    expect(resumed.phase).toBe("verify");
    expect(resumed.toolCallsUsed).toBe(12);
    expect(resumed.verifyRounds).toBe(1);
  });

  it("tracks tool calls incrementally", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    const state = new ComprehensionState(vault, undefined, makeStateOptions());
    state.useToolCalls(3);
    state.useToolCalls(2);
    expect(state.get().toolCallsUsed).toBe(5);
  });

  it("notes hot topics once", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    const state = new ComprehensionState(vault, undefined, makeStateOptions());
    state.noteHotTopic("colmac");
    state.noteHotTopic("colmac");
    expect(state.get().hotTopicsHit).toEqual(["colmac"]);
  });

  it("resets to a fresh run while preserving the budget", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    const state = new ComprehensionState(vault, undefined, makeStateOptions({ toolCallBudget: 30 }));
    state.update({ phase: "summarize", complete: true });
    state.reset();
    const fresh = state.get();
    expect(fresh.phase).toBe("cover");
    expect(fresh.complete).toBe(false);
    expect(fresh.toolCallBudget).toBe(30);
  });

  it("ignores a corrupt state file", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    fs.mkdirSync(path.join(vault, ".note-maintainer"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".note-maintainer/comprehension-state.json"),
      "not json",
      "utf-8",
    );
    const state = new ComprehensionState(vault, undefined, makeStateOptions());
    expect(state.get().phase).toBe("cover");
  });
});

describe("ledger + state integration", () => {
  it("computes status from a real ledger", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-"));
    tempDirs.push(vault);
    const ledger = new AssumptionLedger(vault);
    ledger.add("strong hypothesis", 0.9, "a/note.md:Intro:1-5");
    const status = computeStatus(ledger.entriesSnapshot(), makeStateOptions(), 0.9, 2, true);
    expect(status.status).toBe("confirmed");
  });
});
