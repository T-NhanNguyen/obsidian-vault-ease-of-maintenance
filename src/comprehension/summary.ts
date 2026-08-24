// Vault Summary Card — the durable one-page "book report" written at the end
// of a comprehension run (GraphChat design, milestone 1). Compact markdown
// with frontmatter, the final synthesis, the leading assumptions, and the
// per-directory coverage. Later agent sessions load it instantly via
// SummaryCardStore.read() instead of starting from scratch.

import { VaultIO } from "../io/vault_io";
import { SUMMARY_FILENAME } from "./paths";
import { parseFrontmatter } from "./skim";
import type { LedgerEntry } from "./ledger";
import type { SkimDirectorySummary } from "./skim";
import type { ComprehensionStatus } from "./state";
import type { ChatQueryResponse } from "../types";

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

/** The known statuses a summary card may carry — readStructured validates
 * against this set so an unknown status never slips through as reusable. */
const SUMMARY_CARD_STATUSES: readonly ComprehensionStatus[] = [
  "confirmed",
  "needs_verification",
  "conflicted",
  "insufficient_evidence",
  "low_confidence",
];

/** Structured view of a summary card for the run-once reuse check (handoff
 * Part A): frontmatter fields plus the synthesis body. Null when the card is
 * absent or its frontmatter is unparseable. */
export interface StructuredSummaryCard {
  status: ComprehensionStatus | null;
  coverage: number | null;
  flagged: boolean;
  generatedAt: string | null;
  synthesis: string;
}

/** Run-once validity (handoff Part A): a card is reusable when it exists
 * with a confirmed status and no flag. Shared by the run-once check in
 * runtime_comprehension.ts and the comprehend_vault tool. A type guard:
 * when it returns true, the card is non-null and reusable. */
export function isReusableCard(card: StructuredSummaryCard | null): card is StructuredSummaryCard {
  return card !== null && card.status === "confirmed" && !card.flagged;
}

/** Run-once options (handoff Part A): forceRefresh bypasses the summary-card
 * reuse check so the pipeline always re-runs. */
export interface RunComprehensionOptions {
  forceRefresh?: boolean;
}

/** The reuse answer when a valid summary card short-circuits the run (handoff
 * Part A): state clearly that the run reused the summary and give the
 * generated_at date. No pipeline state is touched on this path. */
export function buildReuseAnswer(card: StructuredSummaryCard): ChatQueryResponse {
  const generatedAt = card.generatedAt ?? "unknown";
  return {
    answer:
      `${card.synthesis}\n\n---\n**Vault summary card:** \`.note-maintainer/vault-summary.md\` ` +
      `(reused from ${generatedAt}; status confirmed — no new comprehension run)`,
    results: [],
    citationMap: {},
  };
}

/** Extract the synthesis section from a card body: everything between the
 * H1 title line and the first `## ` section heading, trimmed. */
function extractSynthesis(body: string): string {
  const trimmed = body.trim();
  const sectionIdx = trimmed.indexOf("\n## ");
  const candidate = sectionIdx === -1 ? trimmed : trimmed.slice(0, sectionIdx);
  const h1Idx = candidate.indexOf("\n");
  return h1Idx === -1 ? "" : candidate.slice(h1Idx + 1).trim();
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

  /** Structured read for the run-once reuse check (handoff Part A): parses
   * the card's frontmatter + synthesis so the caller can decide validity
   * without re-reading raw markdown. Returns null when the card is absent
   * or its frontmatter is unparseable. */
  readStructured(): StructuredSummaryCard | null {
    const card = this.read();
    if (!card) return null;
    const { frontmatter, body } = parseFrontmatter(card);
    if (!frontmatter) return null;
    const rawStatus = frontmatter["status"];
    const status =
      typeof rawStatus === "string" &&
      (SUMMARY_CARD_STATUSES as readonly string[]).includes(rawStatus)
        ? (rawStatus as ComprehensionStatus)
        : null;
    const coverage = typeof frontmatter["coverage"] === "number" ? frontmatter["coverage"] : null;
    const flagged = frontmatter["flagged"] === true;
    const generatedAt =
      typeof frontmatter["generated_at"] === "string" ? frontmatter["generated_at"] : null;
    return { status, coverage, flagged, generatedAt, synthesis: extractSynthesis(body) };
  }

  exists(): boolean {
    return this.io.exists(this.filePath);
  }
}
