// Vault summary card tests — deterministic markdown assembly and the
// SummaryCardStore read/write round trip.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSummaryCard,
  SummaryCardStore,
  type SummaryCardData,
} from "../../src/comprehension/summary";
import type { LedgerEntry } from "../../src/comprehension/ledger";

const tempDirs: string[] = [];

function entry(id: string, score: number, assumption: string, evidence: string[] = []): LedgerEntry {
  const now = new Date().toISOString();
  return {
    id,
    assumption,
    score,
    evidence,
    contradicts: [],
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

function data(overrides: Partial<SummaryCardData> = {}): SummaryCardData {
  return {
    title: "test-vault",
    status: "confirmed",
    coverage: 0.9,
    toolCallsUsed: 42,
    verifyRounds: 2,
    topEntries: [entry("a1", 0.9, "mostly about cooking")],
    directorySummaries: [
      { path: "recipes", fileCount: 3, avgWords: 120, dominantTags: [{ tag: "food", count: 3 }] },
    ],
    synthesis: "The vault is a personal recipe collection.",
    flagged: false,
    generatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSummaryCard", () => {
  it("is deterministic for identical inputs", () => {
    expect(buildSummaryCard(data())).toBe(buildSummaryCard(data()));
  });

  it("emits frontmatter with status, coverage, and budget", () => {
    const card = buildSummaryCard(data());
    expect(card).toContain("type: vault-summary");
    expect(card).toContain("status: confirmed");
    expect(card).toContain("flagged: false");
    expect(card).toContain("coverage: 0.90");
    expect(card).toContain("tool_calls_used: 42");
    expect(card).toContain("verify_rounds: 2");
  });

  it("includes the synthesis, leading assumptions, and coverage lines", () => {
    const card = buildSummaryCard(data());
    expect(card).toContain("# Vault Summary — test-vault");
    expect(card).toContain("The vault is a personal recipe collection.");
    expect(card).toContain("**[0.90] a1** — mostly about cooking");
    expect(card).toContain("- recipes — 3 note(s), avg 120 words, tags: food (3)");
  });

  it("flags low-confidence runs", () => {
    const card = buildSummaryCard(data({ status: "low_confidence", flagged: true }));
    expect(card).toContain("status: low_confidence");
    expect(card).toContain("flagged: true");
    expect(card).toContain("(flagged)");
  });

  it("handles empty ledger and coverage", () => {
    const card = buildSummaryCard(
      data({ topEntries: [], directorySummaries: [], synthesis: "nothing yet" }),
    );
    expect(card).toContain("- (none recorded)");
    expect(card).toContain("- (no directories scanned)");
  });
});

describe("SummaryCardStore", () => {
  it("writes, reads, and reports existence", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-summary-"));
    tempDirs.push(vault);
    const store = new SummaryCardStore(vault);
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeNull();
    const card = buildSummaryCard(data());
    store.write(card);
    expect(store.exists()).toBe(true);
    expect(store.read()).toBe(card);
  });
});
