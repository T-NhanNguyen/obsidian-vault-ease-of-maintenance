// Assumption Ledger — the agent's reading notebook (GraphChat design,
// milestone 1). A small, agent-writable, persistent JSON store of hypotheses
// with confidence marks and evidence. Survives between invocations so the
// agent has durable state across turns.
//
// Four commands (add / score / delete / print) plus a status command; every
// mutation is written atomically and idempotently. print() returns compact
// JSON sorted by score (a standard stable sort — the bubble sort in the draft
// was dropped: identical output, no point in reimplementing it).

import { VaultIO } from "../io/vault_io";
import { LEDGER_FILENAME } from "./paths";

/** Bump to invalidate stored ledgers (schema change). */
export const LEDGER_VERSION = 1;

export type LedgerEntryStatus = "open" | "confirmed" | "refuted";

export interface LedgerEntry {
  id: string;
  assumption: string;
  /** Confidence 0..1. */
  score: number;
  /** Compact evidence strings ("path:heading:lines" or short notes). */
  evidence: string[];
  /** Ids of entries this assumption directly contradicts. */
  contradicts: string[];
  status: LedgerEntryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerOptions {
  /** Score at/above which an entry is "confirmed". */
  confirmThreshold: number;
  /** Score at/below which an entry is "refuted". */
  refuteThreshold: number;
}

interface LedgerFile {
  version: number;
  entries: LedgerEntry[];
}

function defaultOptions(): LedgerOptions {
  return { confirmThreshold: 0.8, refuteThreshold: 0 };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

export class AssumptionLedger {
  private io: VaultIO;
  private filePath: string;
  private options: LedgerOptions;
  private entries: LedgerEntry[] = [];
  private loaded = false;

  constructor(vaultPath: string, filePath?: string, options?: Partial<LedgerOptions>) {
    this.io = new VaultIO(vaultPath);
    this.filePath = filePath || LEDGER_FILENAME;
    this.options = { ...defaultOptions(), ...options };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.io.exists(this.filePath)) return;
    try {
      const parsed = JSON.parse(this.io.readText(this.filePath)) as LedgerFile;
      if (parsed.version === LEDGER_VERSION && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries;
      }
    } catch {
      // Corrupt / partial ledger — start clean, never crash the pipeline.
    }
  }

  private save(): void {
    const file: LedgerFile = { version: LEDGER_VERSION, entries: this.entries };
    this.io.writeTextAtomic(this.filePath, JSON.stringify(file));
  }

  private nextId(): string {
    let max = 0;
    for (const e of this.entries) {
      const numeric = Number(e.id.replace(/^a/, ""));
      if (Number.isFinite(numeric) && numeric > max) max = numeric;
    }
    return `a${max + 1}`;
  }

  private deriveStatus(score: number): LedgerEntryStatus {
    if (score >= this.options.confirmThreshold) return "confirmed";
    if (score <= this.options.refuteThreshold) return "refuted";
    return "open";
  }

  /** add — record a new assumption. Returns the stored entry. */
  add(
    assumption: string,
    score: number = 0.5,
    evidence?: string,
    contradicts?: string | string[],
  ): LedgerEntry {
    this.ensureLoaded();
    const id = this.nextId();
    const now = new Date().toISOString();
    const entry: LedgerEntry = {
      id,
      assumption: assumption.trim(),
      score: clampScore(score),
      evidence: evidence ? [evidence] : [],
      contradicts: normalizeIds(contradicts),
      status: this.deriveStatus(clampScore(score)),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** score — adjust an assumption's confidence by a signed delta, append
   * optional evidence, and merge optional contradiction links. */
  score(
    id: string,
    adjustment: number,
    evidence?: string,
    contradicts?: string | string[],
  ): LedgerEntry | null {
    this.ensureLoaded();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    // Round to 4 decimals — float noise (0.6 + 0.3 = 0.8999…) must not leak
    // into stored confidence scores.
    entry.score = clampScore(Math.round((entry.score + adjustment) * 10000) / 10000);
    if (evidence) entry.evidence.push(evidence);
    if (contradicts) {
      for (const other of normalizeIds(contradicts)) {
        if (!entry.contradicts.includes(other)) entry.contradicts.push(other);
      }
    }
    entry.status = this.deriveStatus(entry.score);
    entry.updatedAt = new Date().toISOString();
    this.save();
    return entry;
  }

  /** delete — prune one assumption (or clear the whole ledger). */
  delete(id: string): boolean {
    this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  clear(): number {
    this.ensureLoaded();
    const removed = this.entries.length;
    if (removed > 0) {
      this.entries = [];
      this.save();
    }
    return removed;
  }

  get(id: string): LedgerEntry | null {
    this.ensureLoaded();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  entriesSnapshot(): LedgerEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  count(): number {
    this.ensureLoaded();
    return this.entries.length;
  }

  /** Sorted view — score descending, ties broken by createdAt then id
   * (deterministic; ISO timestamps sort chronologically). */
  sortedEntries(): LedgerEntry[] {
    return this.entriesSnapshot().sort(
      (a, b) =>
        b.score - a.score ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** print — compact JSON (the agent's token-efficient view), or a
   * human-readable table when `human` is set (testing only). */
  print(top?: number, human?: boolean): string {
    const sorted = this.sortedEntries();
    const slice = top && top > 0 ? sorted.slice(0, top) : sorted;
    if (human) {
      if (slice.length === 0) return "(ledger empty)";
      return slice
        .map(
          (e) =>
            `${e.id}  [${e.score.toFixed(2)}]  ${e.status}  ${e.assumption}` +
            (e.evidence.length > 0 ? `  (${e.evidence.join("; ")})` : ""),
        )
        .join("\n");
    }
    return JSON.stringify({ count: slice.length, entries: slice });
  }
}

function normalizeIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))];
}
