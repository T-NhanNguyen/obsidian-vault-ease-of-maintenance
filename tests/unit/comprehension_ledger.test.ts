// Assumption ledger tests — the four commands (add / score / delete / print),
// persistence round-trips, deterministic sorting, status derivation, and the
// compact-JSON / human print modes.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AssumptionLedger, type LedgerEntry } from "../../src/comprehension/ledger";

const tempDirs: string[] = [];

function makeLedger(
  overrides?: { confirmThreshold?: number; refuteThreshold?: number },
): { vault: string; ledger: AssumptionLedger } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-ledger-"));
  tempDirs.push(vault);
  const ledger = new AssumptionLedger(vault, undefined, overrides);
  return { vault, ledger };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ledger — add", () => {
  it("records an assumption with an id, default score, and timestamps", () => {
    const { ledger } = makeLedger();
    const entry = ledger.add("The vault is mostly about cooking");
    expect(entry.id).toBe("a1");
    expect(entry.score).toBe(0.5);
    expect(entry.status).toBe("open");
    expect(entry.evidence).toEqual([]);
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.updatedAt).toBe(entry.createdAt);
  });

  it("assigns monotonic ids", () => {
    const { ledger } = makeLedger();
    ledger.add("one");
    ledger.add("two");
    ledger.add("three");
    expect(ledger.entriesSnapshot().map((e) => e.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("stores evidence and contradiction links", () => {
    const { ledger } = makeLedger();
    const a = ledger.add("hypothesis A", 0.7, "README.md:Intro:1-5");
    const b = ledger.add("hypothesis B", 0.7, "folder/note.md:Body:10-20", [a.id]);
    expect(a.contradicts).toEqual([]);
    expect(b.contradicts).toEqual([a.id]);
  });

  it("clamps scores to 0..1", () => {
    const { ledger } = makeLedger();
    expect(ledger.add("high", 2).score).toBe(1);
    expect(ledger.add("low", -5).score).toBe(0);
  });
});

describe("ledger — score", () => {
  it("adjusts by a signed delta and appends evidence", () => {
    const { ledger } = makeLedger();
    const entry = ledger.add("assumption", 0.5);
    const updated = ledger.score(entry.id, +0.3, "a/note.md:Section:1-5")!;
    expect(updated.score).toBe(0.8);
    expect(updated.status).toBe("confirmed"); // 0.8 hits the inclusive threshold
    expect(updated.evidence).toEqual(["a/note.md:Section:1-5"]);
  });

  it("derives confirmed/refuted status from the thresholds", () => {
    const { ledger } = makeLedger({ confirmThreshold: 0.8, refuteThreshold: 0 });
    const entry = ledger.add("assumption", 0.5);
    expect(ledger.score(entry.id, +0.3)!.status).toBe("confirmed");
    expect(ledger.score(entry.id, -0.9)!.status).toBe("refuted");
    expect(ledger.score(entry.id, +0.2)!.status).toBe("open");
  });

  it("returns null for an unknown id", () => {
    const { ledger } = makeLedger();
    expect(ledger.score("a99", +0.1)).toBeNull();
  });

  it("merges contradiction links without duplicates", () => {
    const { ledger } = makeLedger();
    const a = ledger.add("A");
    const b = ledger.add("B");
    ledger.score(b.id, 0, undefined, a.id);
    ledger.score(b.id, 0, undefined, a.id);
    expect(ledger.get(b.id)!.contradicts).toEqual([a.id]);
  });
});

describe("ledger — delete and clear", () => {
  it("deletes one assumption", () => {
    const { ledger } = makeLedger();
    ledger.add("one");
    const two = ledger.add("two");
    expect(ledger.delete(two.id)).toBe(true);
    expect(ledger.count()).toBe(1);
    expect(ledger.delete(two.id)).toBe(false);
  });

  it("clears the whole ledger and returns the removed count", () => {
    const { ledger } = makeLedger();
    ledger.add("one");
    ledger.add("two");
    expect(ledger.clear()).toBe(2);
    expect(ledger.count()).toBe(0);
    expect(ledger.clear()).toBe(0);
  });
});

describe("ledger — persistence", () => {
  it("survives a round trip through a new instance", () => {
    const { vault } = makeLedger();
    const first = new AssumptionLedger(vault);
    const entry = first.add("durable assumption", 0.9, "evidence");
    const second = new AssumptionLedger(vault);
    expect(second.get(entry.id)).toMatchObject({
      assumption: "durable assumption",
      score: 0.9,
      evidence: ["evidence"],
    });
  });

  it("ignores a corrupt ledger file", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-ledger-"));
    tempDirs.push(vault);
    fs.mkdirSync(path.join(vault, ".note-maintainer"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".note-maintainer/comprehension-ledger.json"),
      "{ corrupt",
      "utf-8",
    );
    const ledger = new AssumptionLedger(vault);
    expect(ledger.count()).toBe(0);
    ledger.add("fresh");
    expect(ledger.count()).toBe(1);
  });
});

describe("ledger — print", () => {
  it("sorts by score descending with deterministic tiebreaks", () => {
    const { ledger } = makeLedger();
    ledger.add("low", 0.3);
    ledger.add("high", 0.9);
    ledger.add("mid", 0.6);
    const sorted = ledger.sortedEntries().map((e) => e.score);
    expect(sorted).toEqual([0.9, 0.6, 0.3]);
  });

  it("prints compact JSON", () => {
    const { ledger } = makeLedger();
    ledger.add("assumption", 0.7, "a/note.md:Section:1-5");
    const printed = ledger.print();
    const parsed = JSON.parse(printed) as { count: number; entries: LedgerEntry[] };
    expect(parsed.count).toBe(1);
    expect(parsed.entries[0].assumption).toBe("assumption");
  });

  it("prints a human-readable table when asked (testing only)", () => {
    const { ledger } = makeLedger();
    ledger.add("assumption", 0.75, "evidence x");
    const human = ledger.print(undefined, true);
    expect(human).toContain("a1");
    expect(human).toContain("[0.75]");
    expect(human).toContain("assumption");
    expect(human).toContain("evidence x");
  });

  it("prints the top-N slice", () => {
    const { ledger } = makeLedger();
    ledger.add("one", 0.9);
    ledger.add("two", 0.8);
    ledger.add("three", 0.7);
    const parsed = JSON.parse(ledger.print(2)) as { entries: LedgerEntry[] };
    expect(parsed.entries.map((e) => e.assumption)).toEqual(["one", "two"]);
  });
});
