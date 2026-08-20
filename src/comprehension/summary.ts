// Vault Summary Card — the durable one-page "book report" written at the end
// of a comprehension run (GraphChat design, milestone 1). Compact markdown
// with frontmatter, the final synthesis, the leading assumptions, and the
// per-directory coverage. Later agent sessions load it instantly via
// SummaryCardStore.read() instead of starting from scratch.

import { VaultIO } from "../io/vault_io";
import { SUMMARY_FILENAME } from "./paths";
import type { LedgerEntry } from "./ledger";
import type { SkimDirectorySummary } from "./skim";
import type { ComprehensionStatus } from "./state";

export interface SummaryCardData {
  /** Vault name (basename of the vault path). */
  title: string;
  status: ComprehensionStatus;
  coverage: number;
  toolCallsUsed: number;
  verifyRounds: number;
  /** Sorted leading assumptions (score desc). */
  topEntries: LedgerEntry[];
  directorySummaries: SkimDirectorySummary[];
  /** The agent's final synthesis text. */
  synthesis: string;
  /** True when the card is flagged (low_confidence / NO_ANSWER / budget stop). */
  flagged: boolean;
  /** Explicit timestamp for deterministic tests; defaults to now. */
  generatedAt?: string;
}

function coverageLine(summary: SkimDirectorySummary): string {
  const tags =
    summary.dominantTags.length > 0
      ? summary.dominantTags.map((t) => `${t.tag} (${t.count})`).join(", ")
      : "—";
  const dir = summary.path === "" ? "(vault root)" : summary.path;
  return `- ${dir} — ${summary.fileCount} note(s), avg ${summary.avgWords} words, tags: ${tags}`;
}

function assumptionLine(entry: LedgerEntry): string {
  const evidence = entry.evidence.length > 0 ? ` (evidence: ${entry.evidence.join("; ")})` : "";
  return `- **[${entry.score.toFixed(2)}] ${entry.id}** — ${entry.assumption}${evidence}`;
}

/** Deterministic markdown assembly — same inputs, same card (the timestamp
 * is injected via generatedAt). */
export function buildSummaryCard(data: SummaryCardData): string {
  const generatedAt = data.generatedAt ?? new Date().toISOString();
  const sorted = [...data.topEntries].sort(
    (a, b) =>
      b.score - a.score ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const lines = [
    "---",
    "type: vault-summary",
    `generated_at: ${generatedAt}`,
    `status: ${data.status}`,
    `flagged: ${data.flagged}`,
    `coverage: ${data.coverage.toFixed(2)}`,
    `tool_calls_used: ${data.toolCallsUsed}`,
    `verify_rounds: ${data.verifyRounds}`,
    "---",
    `# Vault Summary — ${data.title}`,
    "",
    data.synthesis.trim(),
    "",
    "## Leading assumptions",
    "",
    ...(sorted.length > 0
      ? sorted.map(assumptionLine)
      : ["- (none recorded)"]),
    "",
    "## Coverage",
    "",
    ...(data.directorySummaries.length > 0
      ? data.directorySummaries.map(coverageLine)
      : ["- (no directories scanned)"]),
    "",
    "---",
    `_Generated ${generatedAt}; status ${data.status}${data.flagged ? " (flagged)" : ""}._`,
    "",
  ];
  return lines.join("\n");
}

export class SummaryCardStore {
  private io: VaultIO;
  private filePath: string;

  constructor(vaultPath: string, filePath?: string) {
    this.io = new VaultIO(vaultPath);
    this.filePath = filePath || SUMMARY_FILENAME;
  }

  write(card: string): void {
    this.io.writeTextAtomic(this.filePath, card);
  }

  read(): string | null {
    if (!this.io.exists(this.filePath)) return null;
    return this.io.readText(this.filePath);
  }

  exists(): boolean {
    return this.io.exists(this.filePath);
  }
}
