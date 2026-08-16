// Journal + Receipt — the sort pipeline's durable idempotency journal and
// verifiable edit receipts. Split out of engine.ts so the journal concern
// can be adjusted without touching the registry/validators/filters.

import * as path from "path";
import { settings } from "../config";
import { VaultIO } from "../io/vault_io";

export interface JournalEntryData {
  unitId: string;
  idempotencyKey: string;
  sourceHandle: string;
  state: string; // pending | placed | flagged
  destinationHandle?: string;
  heading?: string;
  receiptId?: string;
  reason?: string;
}

// JSONL row shape written by toJSON and read back by fromJSON.
export interface JournalEntryRow {
  unit_id: string;
  idempotency_key: string;
  source_handle: string;
  state: string;
  destination_handle?: string;
  heading?: string;
  receipt_id?: string;
  reason?: string;
}

export class JournalEntry {
  constructor(
    public unitId: string,
    public idempotencyKey: string,
    public sourceHandle: string,
    public state: string,
    public destinationHandle?: string,
    public heading?: string,
    public receiptId?: string,
    public reason?: string,
  ) {}

  toJSON(): string {
    return JSON.stringify({
      unit_id: this.unitId,
      idempotency_key: this.idempotencyKey,
      source_handle: this.sourceHandle,
      state: this.state,
      destination_handle: this.destinationHandle,
      heading: this.heading,
      receipt_id: this.receiptId,
      reason: this.reason,
    });
  }

  static fromJSON(data: JournalEntryRow): JournalEntry {
    return new JournalEntry(
      data.unit_id,
      data.idempotency_key,
      data.source_handle,
      data.state,
      data.destination_handle,
      data.heading,
      data.receipt_id,
      data.reason,
    );
  }
}

export class Journal {
  private filePath: string;
  private io: VaultIO;
  private entries: JournalEntry[] = [];
  private loaded = false;

  constructor(filePath?: string) {
    this.io = new VaultIO(settings.vaultPath);
    // Journal lives inside the vault (confinement); an explicit path is
    // accepted for tests.
    this.filePath = filePath || path.join(".note-maintainer", "sort-journal.jsonl").replace(/\\/g, "/");
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.io.exists(this.filePath)) {
      const lines = this.io.readText(this.filePath).split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.entries.push(JournalEntry.fromJSON(JSON.parse(trimmed) as JournalEntryRow));
        }
      }
    }
  }

  append(entry: JournalEntry): void {
    this.ensureLoaded();
    this.entries.push(entry);
    this.io.appendText(this.filePath, entry.toJSON() + "\n");
  }

  hasIdempotencyKey(key: string): boolean {
    this.ensureLoaded();
    return this.entries.some(
      e => e.idempotencyKey === key && (e.state === "placed" || e.state === "flagged")
    );
  }

  pendingUnits(): JournalEntry[] {
    this.ensureLoaded();
    return this.entries.filter(e => e.state === "pending");
  }

  allEntries(): JournalEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.loaded = true;
    if (this.io.exists(this.filePath)) {
      this.io.remove(this.filePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt — verifiable proof of work
// ---------------------------------------------------------------------------

// Wire shape of a receipt (what apply_edits returns as JSON and the runtime
// parses back) — snake_case, matching the Python original's to_dict() and
// EditReceipt in runtime_cleanup.ts.
export interface ReceiptData {
  receipt_id: string;
  handle: string;
  hash_before: string;
  hash_after: string;
  ops_applied: number;
  ops_rejected: number;
  diff_stat: Record<string, number>;
  validation: {
    passed: boolean;
    checks: Record<string, string>;
  };
}

let receiptCounter = 0;

export class Receipt {
  constructor(
    public receiptId: string,
    public handle: string,
    public hashBefore: string,
    public hashAfter: string,
    public opsApplied: number,
    public opsRejected: number,
    public diffStat: Record<string, number>,
    public validation: { passed: boolean; checks: Record<string, string> },
  ) {}

  static create(
    handle: string,
    hashBefore: string,
    hashAfter: string,
    opsApplied: number,
    opsRejected: number,
    diffStat: Record<string, number>,
    validationResults: Record<string, [boolean, string]>,
  ): Receipt {
    receiptCounter += 1;
    const validationPassed = Object.values(validationResults).every(v => v[0]);
    const checks: Record<string, string> = {};
    for (const [k, v] of Object.entries(validationResults)) {
      checks[k] = v[1];
    }
    return new Receipt(
      `r_${String(receiptCounter).padStart(4, "0")}`,
      handle,
      hashBefore,
      hashAfter,
      opsApplied,
      opsRejected,
      diffStat,
      { passed: validationPassed, checks },
    );
  }

  toDict(): ReceiptData {
    return {
      receipt_id: this.receiptId,
      handle: this.handle,
      hash_before: this.hashBefore,
      hash_after: this.hashAfter,
      ops_applied: this.opsApplied,
      ops_rejected: this.opsRejected,
      diff_stat: this.diffStat,
      validation: this.validation,
    };
  }
}
