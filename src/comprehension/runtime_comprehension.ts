// Comprehension runtime — the read-the-vault-like-a-book agent loop
// (GraphChat design, milestone 2). Drives the LLM through the protocol
// (cover → texture → structure → verify → deepen → summarize) with a fixed
// toolset (skim / ledger_* / verify / load_summary / clarify), enforces the
// deterministic status machine and clarification triggers, counts a hard
// tool-call budget (not rounds), persists phase state between invocations
// (resume), and writes the durable vault summary card at the end.
//
// Unlike LLMClient.chat, this loop is driven turn-by-turn against the raw
// ILlmClient so the runtime can: count tool calls, evaluate status after
// every batch, run mandatory clarifications itself (injecting the answer as
// a new user message), nudge an early-stopping model to continue, and write
// state after every turn (crash-resume).

import * as path from "path";
import {
  settings,
  resolveApiKey,
  defaultSettings,
  type ComprehensionSettings,
} from "../config";
import { errorMessage } from "../errors";
import { parseIgnorePatterns } from "../agent/engine";
import { Tool } from "../agent/llm";
import {
  getLlmClient,
  detectProvider,
  type ILlmClient,
  type ChatMessage,
} from "../agent/llm_client";
import {
  withClarify,
  NO_ANSWER_MARKER_PREFIX,
  type ClarifyAnswerProvider,
} from "../agent/tools";
import { appendClarifyTurn } from "../agent/chat_session";
import { Embedder, type IEmbedder } from "../indexer/embedder";
import { DatabaseManager } from "../indexer/db";
import type { HybridQueryDb } from "../indexer/graph_search";
import { verifyQuestions, type VerifyResult } from "./verify";
import {
  sampleVault,
  extractTags,
  parseFrontmatter,
  headingOutline,
  countWords,
  firstWords,
  type SkimReport,
  type SkimOptions,
} from "./skim";
import { VaultIO } from "../io/vault_io";
import { AssumptionLedger } from "./ledger";
import {
  ComprehensionState,
  computeStatus,
  evaluateClarification,
  leadingEntries,
  type StateOptions,
  type ClarificationDecision,
  type ComprehensionStatus,
} from "./state";
import { buildSummaryCard, SummaryCardStore } from "./summary";
import { SKIM_CACHE_FILENAME } from "./paths";
import type { ChatQueryResponse, ChatQueryResult } from "../types";
import { readPromptSection, fillTemplate } from "../definitions";
import protocolDefinitionMd from "../../maintainer-definitions/comprehension-vault-protocol.md";
import runMessagesDefinitionMd from "../../maintainer-definitions/comprehension-run-messages.md";

/** Safety valve on loop turns — the tool-call budget is the real cap. */
const MAX_TURNS = 40;
/** Mandatory clarifications per run — after this, stop with a flagged card. */
const MAX_CLARIFIES_PER_RUN = 3;
/** Max evidence sources surfaced as chat sources. */
const MAX_EVIDENCE_SOURCES = 6;
/** Default question when the command auto-submits (or the user sends an
 * empty prompt). */
export const DEFAULT_COMPREHENSION_QUESTION = readPromptSection(
  runMessagesDefinitionMd,
  "Default question",
);

// isComprehensionRequest: true only for the explicit "understand the vault"
// request — the command's auto-submitted question, matched case-insensitively.
// The chat pane routes on this so an ordinary follow-up prompt (e.g. "hello")
// is answered by plain RAG chat instead of re-running the whole protocol.
export function isComprehensionRequest(question: string): boolean {
  return question.trim().toLowerCase() === DEFAULT_COMPREHENSION_QUESTION.toLowerCase();
}

export const COMPREHENSION_SYSTEM_PROMPT = readPromptSection(
  protocolDefinitionMd,
  "Protocol",
);

/** Per-turn prompt templates for the comprehension loop, all sourced from
 * maintainer-definitions/comprehension-run-messages.md (tunable without
 * touching code). */
const RUN_MESSAGE_TEMPLATES = {
  nudge: readPromptSection(runMessagesDefinitionMd, "Nudge"),
  optionalClarifyHint: readPromptSection(runMessagesDefinitionMd, "Optional clarification hint"),
  mandatoryAnswered: readPromptSection(runMessagesDefinitionMd, "Mandatory clarification answered"),
  mandatoryNoAnswer: readPromptSection(runMessagesDefinitionMd, "Mandatory clarification no answer"),
  clarifyConflicted: readPromptSection(runMessagesDefinitionMd, "Clarify question conflicted"),
  clarifyInsufficient: readPromptSection(runMessagesDefinitionMd, "Clarify question insufficient evidence"),
  clarifyBudget: readPromptSection(runMessagesDefinitionMd, "Clarify question budget exhausted"),
  finalSynthesisRequest: readPromptSection(runMessagesDefinitionMd, "Final synthesis request"),
} as const;

// ---------------------------------------------------------------------------
// Test seams (the same pattern as the chat runtime's client factory)
// ---------------------------------------------------------------------------

let comprehensionLlmFactory: (() => ILlmClient) | null = null;
export function setComprehensionLlmFactory(factory: (() => ILlmClient) | null): void {
  comprehensionLlmFactory = factory;
}
export function resetComprehensionLlmFactory(): void {
  comprehensionLlmFactory = null;
}

/** Injected retrieval for verify (tests): a fake IEmbedder + a stub
 * HybridQueryDb. Absent in production — the runtime builds the real ones. */
let comprehensionVerifySeam: { embedder: IEmbedder; db: HybridQueryDb } | null = null;
export function setComprehensionVerifySeam(
  seam: { embedder: IEmbedder; db: HybridQueryDb } | null,
): void {
  comprehensionVerifySeam = seam;
}
export function resetComprehensionVerifySeam(): void {
  comprehensionVerifySeam = null;
}

// ---------------------------------------------------------------------------
// Options helpers
// ---------------------------------------------------------------------------

function stateOptionsFrom(c: ComprehensionSettings): StateOptions {
  // R2.7: undefined scalars fall back to the defaults — a partial config must
  // never produce an `undefined` threshold (the old "below undefined" reason).
  const d = defaultSettings().comprehension;
  return {
    toolCallBudget: c.toolCallBudget ?? d.toolCallBudget,
    softThreshold: c.softThreshold ?? d.softThreshold,
    confirmThreshold: c.confirmThreshold ?? d.confirmThreshold,
    lowConfidenceThreshold: c.lowConfidenceThreshold ?? d.lowConfidenceThreshold,
    minCoverage: c.minCoverage ?? d.minCoverage,
    hotTopics: c.hotTopics ?? d.hotTopics,
  };
}

function skimOptionsFrom(c: ComprehensionSettings, ignorePatterns: string): SkimOptions {
  return {
    tokenBudget: c.tokenBudget,
    rootExcerptWords: c.rootExcerptWords,
    mocExcerptWords: c.mocExcerptWords,
    regularExcerptWords: c.regularExcerptWords,
    sampleTargetFiles: c.sampleTargetFiles,
    ignorePatterns: parseIgnorePatterns(ignorePatterns),
  };
}

function topFolderOf(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function computeCoverage(report: SkimReport): number {
  // R2.2: the folder universe comes from report.directories (every top-level
  // folder, sampled or not), never from report.notes — notes now exclude
  // unsampled rows and would undercount the denominator. Directory paths are
  // already top-level folder names (or "" for the vault root), so they are
  // used verbatim — topFolderOf is for note paths only.
  const allFolders = new Set(report.directories.map((d) => d.path));
  if (allFolders.size === 0) return 0;
  const sampledFolders = new Set(
    report.notes.filter((n) => n.sampled).map((n) => topFolderOf(n.path)),
  );
  return sampledFolders.size / allFolders.size;
}

// ---------------------------------------------------------------------------
// Dense model-facing skim format (R2.2) — the tool result is a terse line
// report, NOT JSON.stringify(report). JSON stays the on-disk cache + internal
// shape; the model sees one line per note, one line per folder, one header.
// ---------------------------------------------------------------------------

/** Collapse whitespace/newlines and strip pipe chars so one note stays one
 * line and the `|` delimiter survives. */
function flattenLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

function formatTags(tags: string[]): string {
  return tags.length > 0 ? `[${tags.join(", ")}]` : "-";
}

function noteLine(note: SkimReport["notes"][number]): string {
  const tags = extractTags(note.frontmatter).map((t) => t.toLowerCase());
  const excerpt = flattenLine(note.excerpt) || "(no body)";
  return `## ${note.path} | ${note.kind} | ${note.wordCount}w | ${formatTags(tags)} | ${excerpt}`;
}

function folderLine(dir: SkimReport["directories"][number]): string {
  const tags = dir.dominantTags.map((d) => d.tag);
  const name = dir.path === "" ? "(root)" : dir.path;
  return `## folder: ${name} | ${dir.fileCount} files | ~${dir.avgWords}w avg | tags ${formatTags(tags)}`;
}

function formatSkimReport(report: SkimReport, vaultName: string): string {
  const totalFiles = report.directories.reduce((acc, d) => acc + d.fileCount, 0);
  const header =
    `# ${vaultName} — ${totalFiles} files, ${report.directories.length} folders, ` +
    `~${report.totalWords} words total`;
  return [
    header,
    ...report.notes.map(noteLine),
    ...report.directories.map(folderLine),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

interface ComprehensionContext {
  ledger: AssumptionLedger;
  stateStore: ComprehensionState;
  summaryStore: SummaryCardStore;
  skimOptions: SkimOptions;
  stateOptions: StateOptions;
  lastSkimPaths: string[];
  lastDirectories: SkimReport["directories"];
  evidence: ChatQueryResult[];
  synthesis: string;
  /** False once verify reports the index empty — feeds insufficient_evidence. */
  indexAvailable: boolean;
  /** Mandatory clarifications already run this invocation (capped). */
  clarifies: number;
  /** True while a clarification is pending (asked, not yet answered) — the
   * next request exposes ONLY the clarify tool set (R2.4). */
  clarifyPending: boolean;
  /** True when the model wrote its concluding synthesis itself (content
   * stop under confirmed status) — otherwise the runtime asks for one. */
  concludedByModel: boolean;
  ask: ClarifyAnswerProvider | undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase-scoped tools (R2.4) — only the tools relevant to the current phase
// are serialized into the request. During a pending clarification the model
// may only ask the user (plus read the status); it cannot wander.
// ---------------------------------------------------------------------------

/** Max body words returned by the note dive-in tool (R2.5). */
const NOTE_WORD_CAP = 200;

const EXPLORE_PHASE_TOOLS = new Set([
  "skim",
  "note",
  "ledger_add",
  "ledger_score",
  "ledger_delete",
  "ledger_print",
  "ledger_status",
]);
const VERIFY_PHASE_TOOLS = new Set([
  "verify",
  "ledger_score",
  "ledger_print",
  "ledger_status",
]);
const CLARIFY_PHASE_TOOLS = new Set(["clarify", "ledger_status"]);

function toolsForPhase(ctx: ComprehensionContext, tools: Tool[]): Tool[] {
  const phase = ctx.stateStore.get().phase;
  const allowed =
    ctx.clarifyPending
      ? CLARIFY_PHASE_TOOLS
      : phase === "verify"
        ? VERIFY_PHASE_TOOLS
        : EXPLORE_PHASE_TOOLS;
  return tools.filter((t) => allowed.has(t.name));
}

function buildTools(
  ctx: ComprehensionContext,
  ensureDb: () => Promise<DatabaseManager>,
): Tool[] {
  const skimTool = new Tool(
    "skim",
    "Sample the vault: one terse JSON report for the whole vault (or a " +
      "filtered subtree via path_filter) — root/MOC notes get full excerpts, " +
      "regular notes a stratified sample, plus per-folder summaries. " +
      "path_filter is a substring (case-insensitive) restricting which notes " +
      "are returned (the deepen pass).",
    {
      type: "object",
      properties: {
        path_filter: {
          type: "string",
          description: "Optional substring filter — only paths containing it are returned.",
        },
      },
      required: [],
    },
    async (args) => {
      const pathFilter = typeof args.path_filter === "string" ? args.path_filter : undefined;
      const report = sampleVault({
        vaultPath: settings.vaultPath,
        options: ctx.skimOptions,
        pathFilter,
        cachePath: SKIM_CACHE_FILENAME,
      });
      ctx.lastSkimPaths = report.notes.filter((n) => n.sampled).map((n) => n.path);
      ctx.lastDirectories = report.directories;
      const state = ctx.stateStore.get();
      ctx.stateStore.update({
        phase: pathFilter ? "deepen" : state.phase === "cover" ? "texture" : state.phase,
        coverage: computeCoverage(report),
      });
      return formatSkimReport(report, path.basename(settings.vaultPath) || "vault");
    },
  );

  const noteTool = new Tool(
    "note",
    "Read ONE note's bounded view: frontmatter tags, heading outline, first " +
      "200 words, word count. Use when a folder summary or a skim excerpt is " +
      "not enough.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Vault-relative note path, e.g. "01-arch/a1.md".',
        },
      },
      required: ["path"],
    },
    async (args) => {
      const rel = typeof args.path === "string" ? args.path.trim() : "";
      if (!rel) return "Error: note requires a non-empty path";
      try {
        // VaultIO.resolveRel rejects absolute paths and `..` traversal — the
        // guards are inherited by construction.
        const io = new VaultIO(settings.vaultPath);
        const content = io.readText(rel);
        const { frontmatter, body } = parseFrontmatter(content);
        const tags = extractTags(frontmatter).map((t) => t.toLowerCase());
        const outline = headingOutline(body);
        return [
          `path: ${rel}`,
          `words: ${countWords(body)}`,
          `tags: ${tags.length > 0 ? `[${tags.join(", ")}]` : "-"}`,
          "outline:",
          ...(outline.length > 0 ? outline.map((h) => `- ${h}`) : ["(no headings)"]),
          `body (first ${NOTE_WORD_CAP} words):`,
          firstWords(body, NOTE_WORD_CAP) || "(empty body)",
        ].join("\n");
      } catch (e) {
        return `Error: ${errorMessage(e)}`;
      }
    },
  );

  const ledgerAddTool = new Tool(
    "ledger_add",
    "Record a new hypothesis in the assumption ledger. Returns the stored " +
      "entry (id, score, status).",
    {
      type: "object",
      properties: {
        assumption: { type: "string", description: "The hypothesis, one short sentence." },
        score: { type: "number", description: "Initial confidence 0..1 (default 0.5)." },
        evidence: { type: "string", description: "Terse evidence, e.g. \"path:heading:lines\"." },
        contradicts: {
          type: "array",
          items: { type: "string" },
          description: "Ids of entries this hypothesis contradicts.",
        },
      },
      required: ["assumption"],
    },
    async (args) => {
      const assumption = typeof args.assumption === "string" ? args.assumption : "";
      if (!assumption.trim()) return "Error: assumption must be a non-empty string";
      const score = typeof args.score === "number" ? args.score : 0.5;
      const evidence = typeof args.evidence === "string" ? args.evidence : undefined;
      const contradicts = Array.isArray(args.contradicts)
        ? args.contradicts.map(String)
        : typeof args.contradicts === "string"
          ? args.contradicts
          : undefined;
      const entry = ctx.ledger.add(assumption, score, evidence, contradicts);
      return JSON.stringify(entry);
    },
  );

  const ledgerScoreTool = new Tool(
    "ledger_score",
    "Adjust a hypothesis's confidence by a signed delta; optionally append " +
      "evidence and contradiction links. Returns the updated entry.",
    {
      type: "object",
      properties: {
        id: { type: "string", description: "Ledger entry id (e.g. \"a1\")." },
        adjustment: { type: "number", description: "Signed delta, e.g. +0.2 or -0.3 (clamped to 0..1)." },
        evidence: { type: "string", description: "Terse evidence to append." },
        contradicts: {
          type: "array",
          items: { type: "string" },
          description: "Ids of entries this hypothesis contradicts.",
        },
      },
      required: ["id", "adjustment"],
    },
    async (args) => {
      const id = typeof args.id === "string" ? args.id : "";
      const adjustment =
        typeof args.adjustment === "number" ? args.adjustment : Number(args.adjustment);
      if (!id) return "Error: id is required";
      if (!Number.isFinite(adjustment)) return "Error: adjustment must be a number";
      const evidence = typeof args.evidence === "string" ? args.evidence : undefined;
      const contradicts = Array.isArray(args.contradicts)
        ? args.contradicts.map(String)
        : typeof args.contradicts === "string"
          ? args.contradicts
          : undefined;
      const updated = ctx.ledger.score(id, adjustment, evidence, contradicts);
      if (!updated) return `Error: unknown id ${id}`;
      return JSON.stringify(updated);
    },
  );

  const ledgerDeleteTool = new Tool(
    "ledger_delete",
    "Prune one assumption (id) or clear the whole ledger (clear: true).",
    {
      type: "object",
      properties: {
        id: { type: "string", description: "Ledger entry id to delete." },
        clear: { type: "boolean", description: "True to wipe the whole ledger." },
      },
      required: [],
    },
    async (args) => {
      if (args.clear === true) {
        const removed = ctx.ledger.clear();
        return JSON.stringify({ cleared: removed });
      }
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return "Error: id is required (or clear: true)";
      const deleted = ctx.ledger.delete(id);
      return JSON.stringify({ deleted, id });
    },
  );

  const ledgerPrintTool = new Tool(
    "ledger_print",
    "Print the assumption ledger as compact JSON sorted by score (or a " +
      "human-readable table when human is set — testing only).",
    {
      type: "object",
      properties: {
        top: { type: "number", description: "Print only the top-N entries." },
        human: { type: "boolean", description: "Human-readable table (testing)." },
      },
      required: [],
    },
    async (args) => {
      const top = typeof args.top === "number" ? args.top : undefined;
      const human = args.human === true;
      return ctx.ledger.print(top, human);
    },
  );

  const ledgerStatusTool = new Tool(
    "ledger_status",
    "Evaluate the run's status deterministically (confirmed / " +
      "needs_verification / conflicted / insufficient_evidence / " +
      "low_confidence) with the reason string, phase, coverage, and budget.",
    {
      type: "object",
      properties: {},
      required: [],
    },
    async () => {
      const state = ctx.stateStore.get();
      const status = computeStatus(
        ctx.ledger.entriesSnapshot(),
        ctx.stateOptions,
        state.coverage,
        state.verifyRounds,
        ctx.indexAvailable,
      );
      const top = leadingEntries(ctx.ledger.entriesSnapshot(), 1)[0] ?? null;
      return JSON.stringify({
        phase: state.phase,
        status: status.status,
        reason: status.reason,
        coverage: state.coverage,
        tool_calls_used: state.toolCallsUsed,
        tool_call_budget: state.toolCallBudget,
        top_assumption: top ? { id: top.id, assumption: top.assumption, score: top.score } : null,
      });
    },
  );

  const verifyTool = new Tool(
    "verify",
    "Verify assumptions against the GraphRAG index: pass 2-4 precise " +
      "questions as ONE batch; returns top-3 snippets with locations per " +
      "question (index: \"missing\" when the index is empty).",
    {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: { type: "string" },
          description: "2-4 precise questions to retrieve evidence for.",
        },
      },
      required: ["questions"],
    },
    async (args) => {
      const questions = Array.isArray(args.questions)
        ? args.questions.map(String).filter(Boolean)
        : [];
      if (questions.length < 1 || questions.length > 4) {
        return "Error: verify accepts 1-4 questions as one batch (plan: 2-4).";
      }
      const seam = comprehensionVerifySeam;
      const embedder = seam ? seam.embedder : new Embedder(settings);
      const db = seam ? seam.db : await ensureDb();
      const result: VerifyResult = await verifyQuestions(
        embedder,
        db,
        questions,
        settings.comprehension.verifyTopK,
      );
      ctx.indexAvailable = result.index === "ok";
      ctx.stateStore.update({
        phase: "verify",
        verifyRounds: ctx.stateStore.get().verifyRounds + 1,
      });
      for (const qr of result.results) {
        for (const hit of qr.hits) {
          ctx.evidence.push({
            node_key: `${hit.path}::${hit.heading}`,
            file_path: hit.path,
            heading_path: hit.heading,
            score: hit.score,
            text: hit.snippet,
            line_start: hit.lines[0],
            line_end: hit.lines[1],
          });
        }
      }
      if (ctx.evidence.length > MAX_EVIDENCE_SOURCES) {
        ctx.evidence = ctx.evidence.slice(-MAX_EVIDENCE_SOURCES);
      }
      return JSON.stringify(result);
    },
  );

  const loadSummaryTool = new Tool(
    "load_summary",
    "Load the durable vault summary card written by a previous comprehension " +
      "run (instant resume without starting from scratch).",
    {
      type: "object",
      properties: {},
      required: [],
    },
    async () => ctx.summaryStore.read() ?? "(no vault summary card yet)",
  );

  return [
    loadSummaryTool,
    skimTool,
    noteTool,
    ledgerAddTool,
    ledgerScoreTool,
    ledgerDeleteTool,
    ledgerPrintTool,
    ledgerStatusTool,
    verifyTool,
  ];
}

// ---------------------------------------------------------------------------
// Mandatory clarification
// ---------------------------------------------------------------------------

function buildClarifyQuestion(
  decision: ClarificationDecision,
  ledger: AssumptionLedger,
): string {
  if (decision.reason === "conflicted") {
    const leading = leadingEntries(ledger.entriesSnapshot(), 2);
    const lines = leading
      .map((e) => `${e.id} [${e.score.toFixed(2)}] "${e.assumption}"`)
      .join("  vs  ");
    return fillTemplate(RUN_MESSAGE_TEMPLATES.clarifyConflicted, { lines });
  }
  if (decision.reason === "insufficient_evidence") {
    return RUN_MESSAGE_TEMPLATES.clarifyInsufficient;
  }
  return RUN_MESSAGE_TEMPLATES.clarifyBudget;
}

/** Runs a mandatory clarification through the chat answer provider and
 * injects the answer as a new user message. Returns true when answered. */
async function runMandatoryClarify(
  ctx: ComprehensionContext,
  decision: ClarificationDecision,
  messages: ChatMessage[],
): Promise<boolean> {
  const question = buildClarifyQuestion(decision, ctx.ledger);
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const answer = ctx.ask
    ? await ctx.ask({ question, context: decision.detail ?? "", deadline })
    : null;
  appendClarifyTurn(settings.vaultPath, "assistant", question);
  ctx.clarifyPending = true;
  if (answer) {
    appendClarifyTurn(settings.vaultPath, "user", answer);
    ctx.clarifyPending = false; // the model now converts the answer
    messages.push({
      role: "user",
      content: fillTemplate(RUN_MESSAGE_TEMPLATES.mandatoryAnswered, { question, answer }),
    });
    return true;
  }
  messages.push({
    role: "user",
    content: fillTemplate(RUN_MESSAGE_TEMPLATES.mandatoryNoAnswer, { question }),
  });
  return false;
}

// ---------------------------------------------------------------------------
// Bounded-context window (R2.3): a constant-size state card rebuilt every
// turn, plus deterministic sliding-window compaction when the estimated
// conversation exceeds the budget. No extra LLM call is ever made for this.
// ---------------------------------------------------------------------------

/** Context budget in tokens (rule of thumb: chars / 4 ≈ tokens). */
const COMPREHENSION_CONTEXT_BUDGET_TOKENS = 6000;

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return chars / 4;
}

function truncateCard(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Deterministic, constant-ish context card: status, coverage, folder
 * one-liners, top-5 ledger entries, current synthesis. */
function buildStateCard(ctx: ComprehensionContext): string {
  const state = ctx.stateStore.get();
  const topEntries = ctx.ledger.sortedEntries().slice(0, 5);
  const folders = ctx.lastDirectories.map((d) => {
    const name = d.path === "" ? "(root)" : d.path;
    return `${name}(${d.fileCount})`;
  });
  const ledgerLine =
    topEntries.length > 0
      ? topEntries
          .map((e) => `${e.id} "${truncateCard(e.assumption, 40)}" ${e.score.toFixed(2)}`)
          .join("; ")
      : "(empty)";
  const synthesis = ctx.synthesis
    ? `"${truncateCard(ctx.synthesis.replace(/"/g, "'"), 120)}"`
    : "(none yet)";
  return [
    "STATE card",
    `- status: ${state.status} — ${truncateCard(state.statusReason, 90)}`,
    `- coverage: ${state.coverage.toFixed(2)} (${state.verifyRounds} verify round(s))`,
    `- folders: ${folders.join(" ") || "(none)"}`,
    `- ledger: ${ledgerLine}`,
    `- synthesis: ${synthesis}`,
  ].join("\n");
}

/** Replace any previous STATE card message with the fresh one (kept as the
 * last message so compaction below always preserves it). */
function upsertStateCard(messages: ChatMessage[], card: string): void {
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i];
    if (m.role === "system" && (m.content ?? "").startsWith("STATE card")) {
      messages.splice(i, 1);
    }
  }
  messages.push({ role: "system", content: card });
}

/** Deterministic sliding window: keep the system prompt, the state card, the
 * last 2 assistant turns, and the last 2 skim results; drop everything older.
 * In-place so the shared `messages` array stays the single source of truth.
 * Exported for unit testing — the pipeline never calls it directly beyond
 * runLoop. */
export function compactConversation(messages: ChatMessage[], budgetTokens: number): void {
  if (estimateTokens(messages) <= budgetTokens) return;
  const system = messages[0];
  const rest = messages.slice(1);
  const assistantIdx = rest
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);
  const skimIdx = rest
    .map((m, i) => (m.role === "tool" && (m.content ?? "").startsWith("# ") ? i : -1))
    .filter((i) => i >= 0);
  const start = Math.min(
    assistantIdx.length >= 2 ? assistantIdx[assistantIdx.length - 2] : 0,
    skimIdx.length >= 2 ? skimIdx[skimIdx.length - 2] : 0,
  );
  messages.splice(0, messages.length, system, ...rest.slice(start));
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function runLoop(
  ctx: ComprehensionContext,
  llm: ILlmClient,
  modelName: string,
  tools: Tool[],
  messages: ChatMessage[],
): Promise<void> {
  const openaiTools = () => toolsForPhase(ctx, tools).map((t) => t.toOpenAiTool());

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (ctx.stateStore.get().toolCallsUsed >= ctx.stateStore.get().toolCallBudget) break;

    upsertStateCard(messages, buildStateCard(ctx));
    compactConversation(messages, COMPREHENSION_CONTEXT_BUDGET_TOKENS);

    const response = await llm.chatCompletion(modelName, messages, openaiTools());
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: response.content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
      for (const tc of toolCalls) {
        if (ctx.stateStore.get().toolCallsUsed >= ctx.stateStore.get().toolCallBudget) break;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const matched = tools.filter((t) => t.name === tc.function.name);
        const result =
          matched.length > 0
            ? await matched[0].call(args)
            : `Unknown tool: ${tc.function.name}`;
        if (matched[0]?.name === "clarify") {
          ctx.clarifyPending = result.startsWith(NO_ANSWER_MARKER_PREFIX);
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        ctx.stateStore.useToolCalls(1);
      }

      const state = ctx.stateStore.get();
      const status = computeStatus(
        ctx.ledger.entriesSnapshot(),
        ctx.stateOptions,
        state.coverage,
        state.verifyRounds,
        ctx.indexAvailable,
      );
      ctx.stateStore.update({ status: status.status, statusReason: status.reason });
      if (status.status === "confirmed") return;

      const decision = evaluateClarification(
        status,
        ctx.stateStore.get(),
        ctx.stateOptions,
        ctx.lastSkimPaths,
        true, // mid-batch: defer insufficient_evidence — the model may still be building evidence
      );
      if (decision.action === "mandatory") {
        if (ctx.clarifies >= MAX_CLARIFIES_PER_RUN) return;
        ctx.clarifies += 1;
        await runMandatoryClarify(ctx, decision, messages);
        continue;
      }
      if (decision.action === "optional") {
        messages.push({
          role: "system",
          content: fillTemplate(RUN_MESSAGE_TEMPLATES.optionalClarifyHint, {
            reason: decision.reason,
            detail: decision.detail ?? "",
          }),
        });
      }
    } else if (response.content) {
      messages.push({ role: "assistant", content: response.content });
      ctx.synthesis = response.content;

      const state = ctx.stateStore.get();
      const status = computeStatus(
        ctx.ledger.entriesSnapshot(),
        ctx.stateOptions,
        state.coverage,
        state.verifyRounds,
        ctx.indexAvailable,
      );
      ctx.stateStore.update({ status: status.status, statusReason: status.reason });
      if (status.status === "confirmed") {
        ctx.concludedByModel = true;
        return;
      }

      const decision = evaluateClarification(
        status,
        ctx.stateStore.get(),
        ctx.stateOptions,
        ctx.lastSkimPaths,
      );
      if (decision.action === "mandatory") {
        if (ctx.clarifies >= MAX_CLARIFIES_PER_RUN) return;
        ctx.clarifies += 1;
        await runMandatoryClarify(ctx, decision, messages);
        continue;
      }
      // Non-terminal stop: nudge the model to continue the protocol.
      messages.push({
        role: "system",
        content: fillTemplate(RUN_MESSAGE_TEMPLATES.nudge, {
          status: status.status,
          reason: status.reason,
        }),
      });
    } else {
      return; // empty response — nothing more to do
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Runs (or resumes) the vault-comprehension pipeline. Matches the chat
 * query signature so the chat surface (ChatReviewSpec) can host it; the
 * answer is the final synthesis, the results are the verify evidence. */
export async function runComprehension(
  question: string,
  ask?: ClarifyAnswerProvider,
): Promise<ChatQueryResponse> {
  if (!settings.vaultPath) {
    return {
      answer: "No vault open — cannot run the comprehension pipeline.",
      results: [],
      citationMap: {},
    };
  }
  const comprehension = settings.comprehension;
  const stateStore = new ComprehensionState(settings.vaultPath, undefined, stateOptionsFrom(comprehension));
  stateStore.ensureLoaded();
  // Every invocation starts a fresh protocol pass. A stale incomplete state
  // (phase=verify, stale coverage, accumulated counters) must not leak in:
  // with phase-scoped tools it would lock the run out of `skim`, keep a
  // coverage that is never recomputed, and fire a spurious clarification.
  // The durable ledger is a separate store and survives the reset, so the
  // run still picks up prior assumptions.
  stateStore.reset();

  const ledger = new AssumptionLedger(settings.vaultPath);
  const summaryStore = new SummaryCardStore(settings.vaultPath);

  const ctx: ComprehensionContext = {
    ledger,
    stateStore,
    summaryStore,
    skimOptions: skimOptionsFrom(comprehension, settings.ignorePatterns),
    stateOptions: stateOptionsFrom(comprehension),
    lastSkimPaths: [],
    lastDirectories: [],
    evidence: [],
    synthesis: "",
    indexAvailable: true,
    clarifies: 0,
    clarifyPending: false,
    concludedByModel: false,
    ask,
  };

  let db: DatabaseManager | null = null as DatabaseManager | null;
  const ensureDb = async (): Promise<DatabaseManager> => {
    if (!db) db = new DatabaseManager(settings.dbPath);
    return db;
  };

  try {
    const tools = withClarify(buildTools(ctx, ensureDb), ask ?? (() => null));
    const llm = comprehensionLlmFactory
      ? comprehensionLlmFactory()
      : getLlmClient(
          detectProvider(settings.api.baseUrl || ""),
          settings.agent.model,
          resolveApiKey(),
          settings.api.baseUrl,
          false,
        );
    const modelName = settings.agent.model;
    const messages: ChatMessage[] = [
      { role: "system", content: COMPREHENSION_SYSTEM_PROMPT },
      { role: "user", content: question.trim() || DEFAULT_COMPREHENSION_QUESTION },
    ];

    await runLoop(ctx, llm, modelName, tools, messages);

    // The final synthesis is only the model's own concluding message (a
    // content stop under confirmed status). Any other ending — confirmed
    // right after a verify/score batch, budget exhaustion, clarify cap —
    // means the model never wrote it: ask once, with the ledger as the only
    // context it needs.
    if (!ctx.concludedByModel) {
      const response = await llm.chatCompletion(
        modelName,
        [
          ...messages,
          {
            role: "user",
            content: fillTemplate(RUN_MESSAGE_TEMPLATES.finalSynthesisRequest, {
              ledger: ledger.print(5),
            }),
          },
        ],
        null,
      );
      ctx.synthesis =
        response.content || "Vault comprehension completed — see the summary card.";
    }

    const state = ctx.stateStore.get();
    const status: ComprehensionStatus = state.status;
    // A card is flagged exactly when the run did not confirm — the flag is
    // derived from the final status, never from transient early signals.
    const flagged = status !== "confirmed";
    const card = buildSummaryCard({
      title: path.basename(settings.vaultPath) || "vault",
      status,
      coverage: state.coverage,
      toolCallsUsed: state.toolCallsUsed,
      verifyRounds: state.verifyRounds,
      topEntries: ledger.sortedEntries().slice(0, 5),
      directorySummaries: ctx.lastDirectories,
      synthesis: ctx.synthesis,
      flagged,
    });
    summaryStore.write(card);
    stateStore.update({ phase: "summarize", status, statusReason: state.statusReason, complete: true });

    return {
      answer:
        `${ctx.synthesis}\n\n---\n**Vault summary card:** \`.note-maintainer/vault-summary.md\` ` +
        `(status: ${status}${flagged ? ", flagged" : ""})`,
      results: ctx.evidence,
      citationMap: {},
    };
  } catch (e) {
    // Never swallow the real failure — the user must see WHY the run failed.
    console.warn(`[comprehension] Unavailable — LLM error: ${errorMessage(e)}`);
    return {
      answer: `[Comprehension unavailable — LLM error: ${errorMessage(e)}]`,
      results: [],
      citationMap: {},
    };
  } finally {
    const toClose = db;
    if (toClose) await toClose.close();
  }
}
