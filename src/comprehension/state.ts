// Comprehension state machine — the read-the-vault-like-a-book protocol's
// phase tracker and status evaluator (GraphChat design, milestone 1).
//
// Durable state lives in a small JSON file (comprehension-state.json) so each
// invocation reads it and resumes instead of restarting. Status is computed
// deterministically from the ledger, coverage, verify rounds, and index
// availability — never from a vibe — and every status carries a reason string
// the agent simply reads. Clarification fires only when a numeric or pattern
// trigger below fires (never on a whim).

import { VaultIO } from "../io/vault_io";
import { STATE_FILENAME } from "./paths";
import type { LedgerEntry } from "./ledger";

export type ComprehensionPhase =
  | "cover"
  | "texture"
  | "structure"
  | "verify"
  | "deepen"
  | "summarize";

export type ComprehensionStatus =
  | "confirmed" // stop → emit final synthesis
  | "needs_verification" // continue
  | "conflicted" // forced stop → mandatory clarification
  | "insufficient_evidence" // forced stop → mandatory clarification
  | "low_confidence"; // may print the synthesis with a clear flag

export type ClarificationAction = "none" | "optional" | "mandatory";

/** Fraction of the tool-call budget that counts as "nearly exhausted" — the
 * mandatory-clarification trigger (rule 5). */
export const BUDGET_WARN_FRACTION = 0.8;

export interface ComprehensionStateData {
  phase: ComprehensionPhase;
  status: ComprehensionStatus;
  statusReason: string;
  toolCallsUsed: number;
  toolCallBudget: number;
  verifyRounds: number;
  /** Fraction of top-level folders represented in the sampled set (0..1). */
  coverage: number;
  /** Hot-topic keywords seen in newly sampled files. */
  hotTopicsHit: string[];
  lastRunAt: string | null;
  /** True once the durable vault summary card has been written. */
  complete: boolean;
}

export interface StateOptions {
  toolCallBudget: number;
  softThreshold: number;
  confirmThreshold: number;
  lowConfidenceThreshold: number;
  minCoverage: number;
  hotTopics: string[];
}

export interface StatusResult {
  status: ComprehensionStatus;
  reason: string;
}

export interface ClarificationDecision {
  action: ClarificationAction;
  reason: string;
  /** The two leading hypotheses when conflicted; the hot keyword when a hot
   * topic fired; the budget/reason otherwise. */
  detail?: string;
}

export interface ContradictionPair {
  a: string;
  b: string;
}

function defaultOptions(): StateOptions {
  return {
    toolCallBudget: 60,
    softThreshold: 0.7,
    confirmThreshold: 0.8,
    lowConfidenceThreshold: 0.4,
    minCoverage: 0.6,
    hotTopics: [],
  };
}

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

/** Pairs of entries that contradict each other and are both above the soft
 * threshold — the "conflicted" condition. Deterministic: pair ids are
 * normalized (lower id first) and sorted. */
export function contradictingPairs(
  entries: LedgerEntry[],
  softThreshold: number,
): ContradictionPair[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const above = entries.filter((e) => e.score >= softThreshold);
  const pairs: ContradictionPair[] = [];
  const seen = new Set<string>();
  for (const entry of above) {
    for (const otherId of entry.contradicts) {
      const other = byId.get(otherId);
      if (!other || other.score < softThreshold) continue;
      const [a, b] = entry.id < otherId ? [entry.id, otherId] : [otherId, entry.id];
      const key = `${a}<->${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b });
    }
  }
  return pairs.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
}

/** Top-N entries by score (deterministic tiebreaks) — the "leading
 * hypotheses" presented during a conflicted clarification. */
export function leadingEntries(entries: LedgerEntry[], top: number = 2): LedgerEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.score - a.score ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  ).slice(0, top);
}

/**
 * Deterministic status evaluation. Priority order (each step returns with its
 * reason string): conflicted → insufficient_evidence → confirmed →
 * low_confidence → needs_verification.
 */
export function computeStatus(
  entries: LedgerEntry[],
  opts: StateOptions,
  coverage: number,
  verifyRounds: number,
  indexAvailable: boolean,
): StatusResult {
  const pairs = contradictingPairs(entries, opts.softThreshold);
  if (pairs.length > 0) {
    const ids = pairs.map((p) => `${p.a}, ${p.b}`).join("; ");
    return {
      status: "conflicted",
      reason: `Two or more hypotheses above the soft threshold (${opts.softThreshold}) contradict each other: ${ids}. Present the leading hypotheses to the user.`,
    };
  }

  if (!indexAvailable && verifyRounds > 0) {
    return {
      status: "insufficient_evidence",
      reason: "The GraphRAG index is unavailable — the verify phase cannot retrieve evidence. Ask the user for a keyword, folder, or starting note.",
    };
  }

  if (coverage < opts.minCoverage) {
    return {
      status: "insufficient_evidence",
      reason: `Sampled coverage (${coverage.toFixed(2)}) is below the minimum (${opts.minCoverage}). Ask the user for a keyword, folder, or starting note.`,
    };
  }

  if (entries.length === 0) {
    return {
      status: "insufficient_evidence",
      reason: "No assumptions recorded yet. Ask the user for a keyword, folder, or starting note.",
    };
  }

  const top = leadingEntries(entries, 1)[0];
  if (top.score >= opts.confirmThreshold && verifyRounds >= 1) {
    return {
      status: "confirmed",
      reason: `Leading hypothesis "${truncate(top.assumption)}" is at ${top.score.toFixed(2)} (≥ ${opts.confirmThreshold}) after ${verifyRounds} verification round(s), with no contradictions. Stop and emit the final synthesis.`,
    };
  }

  if (top.score < opts.confirmThreshold && verifyRounds >= 1) {
    return {
      status: "low_confidence",
      reason: `Verification completed but the leading hypothesis is at ${top.score.toFixed(2)} (below ${opts.confirmThreshold}). May print the synthesis with a low-confidence flag.`,
    };
  }

  if (top.score >= opts.confirmThreshold) {
    return {
      status: "needs_verification",
      reason: `Leading hypothesis is strong (${top.score.toFixed(2)}) but not yet verified against the index — run the verify phase before confirming.`,
    };
  }

  return {
    status: "needs_verification",
    reason: `Leading hypothesis is at ${top.score.toFixed(2)} (below ${opts.confirmThreshold}). Continue skimming or verifying.`,
  };
}

function truncate(text: string, max: number = 40): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Clarification triggers — deterministic numeric/pattern conditions only.
// The agent never asks on a whim; it asks when one of these fires:
//   1. conflicted → MANDATORY (present the two leading hypotheses). This
//      subsumes the draft's "optional early contradiction nudge": pairs of
//      hypotheses above the soft threshold ARE the conflicted status, so
//      the nudge would always be redundant with the mandatory ask.
//   2. insufficient_evidence → MANDATORY (keyword/folder/starting note).
//   3. A user-supplied hot-topic keyword appears in a newly sampled file →
//      OPTIONAL.
//   4. Tool-call budget ≥ 80% exhausted and status still needs_verification
//      → MANDATORY (the final lever before stopping).
// ---------------------------------------------------------------------------

export function evaluateClarification(
  statusResult: StatusResult,
  state: ComprehensionStateData,
  opts: StateOptions,
  newlySampledPaths: string[],
  deferInsufficientEvidence: boolean = false,
): ClarificationDecision {
  if (statusResult.status === "conflicted") {
    return {
      action: "mandatory",
      reason: "conflicted",
      detail: statusResult.reason,
    };
  }

  // Rule 2. Mid-batch (defer=true) the run may still be building evidence —
  // a fresh skim with an empty ledger must not interrupt the model. The
  // mandatory ask fires when the model tries to conclude (content stop) or
  // the budget trigger below.
  if (statusResult.status === "insufficient_evidence" && !deferInsufficientEvidence) {
    return {
      action: "mandatory",
      reason: "insufficient_evidence",
      detail: statusResult.reason,
    };
  }

  const budgetUsed = state.toolCallBudget > 0 ? state.toolCallsUsed / state.toolCallBudget : 1;
  const budgetNearlyExhausted = budgetUsed >= BUDGET_WARN_FRACTION;

  // Rule 3: hot-topic keyword in a newly sampled file → optional.
  if (opts.hotTopics.length > 0 && newlySampledPaths.length > 0) {
    const hit = opts.hotTopics.find((topic) => {
      const needle = topic.toLowerCase();
      return newlySampledPaths.some((p) => p.toLowerCase().includes(needle));
    });
    if (hit) {
      return {
        action: "optional",
        reason: "hot_topic",
        detail: `Hot-topic keyword "${hit}" appears in a newly sampled file.`,
      };
    }
  }

  // Rule 4: budget nearly exhausted + needs_verification → mandatory.
  if (budgetNearlyExhausted && statusResult.status === "needs_verification") {
    return {
      action: "mandatory",
      reason: "budget",
      detail: `Tool-call budget ${state.toolCallsUsed}/${state.toolCallBudget} nearly exhausted with status needs_verification. Ask the user for guidance before stopping.`,
    };
  }

  return { action: "none", reason: "no_trigger" };
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

export class ComprehensionState {
  private io: VaultIO;
  private filePath: string;
  private options: StateOptions;
  private data: ComprehensionStateData;
  private loaded = false;

  constructor(vaultPath: string, filePath?: string, options?: Partial<StateOptions>) {
    this.io = new VaultIO(vaultPath);
    this.filePath = filePath || STATE_FILENAME;
    this.options = { ...defaultOptions(), ...options };
    this.data = this.freshData();
  }

  private freshData(): ComprehensionStateData {
    return {
      phase: "cover",
      status: "needs_verification",
      statusReason: "",
      toolCallsUsed: 0,
      toolCallBudget: this.options.toolCallBudget,
      verifyRounds: 0,
      coverage: 0,
      hotTopicsHit: [],
      lastRunAt: null,
      complete: false,
    };
  }

  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.io.exists(this.filePath)) return;
    try {
      const parsed = JSON.parse(this.io.readText(this.filePath)) as Partial<ComprehensionStateData>;
      this.data = { ...this.freshData(), ...parsed };
    } catch {
      // Corrupt / partial state — start fresh, never crash the pipeline.
    }
  }

  save(): void {
    this.io.writeTextAtomic(this.filePath, JSON.stringify(this.data));
  }

  get(): ComprehensionStateData {
    this.ensureLoaded();
    return { ...this.data };
  }

  update(mut: Partial<ComprehensionStateData>): ComprehensionStateData {
    this.ensureLoaded();
    this.data = { ...this.data, ...mut };
    this.save();
    return { ...this.data };
  }

  useToolCalls(n: number): void {
    this.update({ toolCallsUsed: this.data.toolCallsUsed + n });
  }

  noteHotTopic(keyword: string): void {
    if (!this.data.hotTopicsHit.includes(keyword)) {
      this.update({ hotTopicsHit: [...this.data.hotTopicsHit, keyword] });
    }
  }

  /** Start a fresh run (or a re-run after completion): phase → cover,
   * counters zeroed, budget preserved. */
  reset(): void {
    this.ensureLoaded();
    this.data = this.freshData();
    this.save();
  }
}
