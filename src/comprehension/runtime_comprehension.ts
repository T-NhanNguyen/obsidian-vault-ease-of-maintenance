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
import { settings, resolveApiKey, type ComprehensionSettings } from "../config";
import { errorMessage } from "../errors";
import { parseIgnorePatterns } from "../agent/engine";
import { Tool } from "../agent/llm";
import {
  getLlmClient,
  detectProvider,
  type ILlmClient,
  type ChatMessage,
} from "../agent/llm_client";
import { withClarify, type ClarifyAnswerProvider } from "../agent/tools";
import { appendClarifyTurn } from "../agent/chat_session";
import { Embedder, type IEmbedder } from "../indexer/embedder";
import { DatabaseManager } from "../indexer/db";
import type { HybridQueryDb } from "../indexer/graph_search";
import { verifyQuestions, type VerifyResult } from "./verify";
import { sampleVault, type SkimReport, type SkimOptions } from "./skim";
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

/** Safety valve on loop turns — the tool-call budget is the real cap. */
const MAX_TURNS = 40;
/** Mandatory clarifications per run — after this, stop with a flagged card. */
const MAX_CLARIFIES_PER_RUN = 3;
/** Max evidence sources surfaced as chat sources. */
const MAX_EVIDENCE_SOURCES = 6;

export const COMPREHENSION_SYSTEM_PROMPT =
  "You are reading a personal notes vault like a book. Follow the protocol:\n" +
  "1. COVER — the skim report's root notes / README / MOC notes are the book " +
  "jacket. Form 1-3 initial hypotheses; record each with ledger_add " +
  "(score 0.3-0.6).\n" +
  "2. TEXTURE — call skim once for the whole vault: it returns a terse JSON " +
  "report (path, first-N-words excerpt, heading outline, word count per note, " +
  "plus one summary line per top-level folder). Synthesize what this vault is " +
  "about; raise/lower hypothesis scores with ledger_score, attaching terse " +
  "evidence like \"path:heading:lines\".\n" +
  "3. STRUCTURE — the report's directory summaries and MOC outlines are the " +
  "table of contents. Cross-check your synthesis; adjust scores.\n" +
  "4. VERIFY — pull your top open assumptions (ledger_print), then call " +
  "verify with 2-4 precise questions as ONE batch. verify returns top-3 " +
  "snippets with locations per question. Score up/down and attach the " +
  "locations as evidence. A few rounds maximum.\n" +
  "5. DEEPEN — if one or two folders dominate, call skim again with " +
  "path_filter set to those folders to read them deeper.\n" +
  "6. SUMMARIZE — when ledger_status reports status \"confirmed\", stop " +
  "calling tools and write the final one-page synthesis (2-5 sentences, " +
  "**bold** key terms).\n" +
  "Rules:\n" +
  "- Every hypothesis lives in the ledger. Never invent facts not in the " +
  "sources; evidence strings are terse.\n" +
  "- Call ledger_status before deciding to stop. Statuses: confirmed (stop + " +
  "synthesize), needs_verification (continue), conflicted / " +
  "insufficient_evidence (the runtime will ask the user — convert the answer " +
  "into ledger changes), low_confidence (may print with a flag).\n" +
  "- Optional clarification (hot topics) may be acted on via clarify.\n" +
  "- The runtime enforces a hard tool-call budget — use calls sparingly.";

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
  return {
    toolCallBudget: c.toolCallBudget,
    softThreshold: c.softThreshold,
    confirmThreshold: c.confirmThreshold,
    lowConfidenceThreshold: c.lowConfidenceThreshold,
    minCoverage: c.minCoverage,
    hotTopics: c.hotTopics,
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
  const allFolders = new Set(report.notes.map((n) => topFolderOf(n.path)));
  if (allFolders.size === 0) return 0;
  const sampledFolders = new Set(
    report.notes.filter((n) => n.sampled).map((n) => topFolderOf(n.path)),
  );
  return sampledFolders.size / allFolders.size;
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
  /** True when the model wrote its concluding synthesis itself (content
   * stop under confirmed status) — otherwise the runtime asks for one. */
  concludedByModel: boolean;
  ask: ClarifyAnswerProvider | undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

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
      return JSON.stringify(report);
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

  return [loadSummaryTool, skimTool, ledgerAddTool, ledgerScoreTool, ledgerDeleteTool, ledgerPrintTool, ledgerStatusTool, verifyTool];
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
    return `Two leading hypotheses contradict each other: ${lines}. Which is right, or how should I reconcile them?`;
  }
  if (decision.reason === "insufficient_evidence") {
    return "I have insufficient evidence to understand this vault. Give me a keyword, folder, or starting note to focus on.";
  }
  return "My tool-call budget is nearly exhausted and the run is not confirmed. What should I prioritize with the remaining calls?";
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
  if (answer) {
    appendClarifyTurn(settings.vaultPath, "user", answer);
    messages.push({
      role: "user",
      content:
        `[Mandatory clarification] ${question}\nUser answer: ${answer}\n` +
        "Convert the answer into ledger changes (ledger_add / ledger_score) and continue.",
    });
    return true;
  }
  messages.push({
    role: "user",
    content:
      `[Mandatory clarification] ${question}\nNo answer received. ` +
      "Continue with the current evidence and stop with a flagged summary.",
  });
  return false;
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
  const openaiTools = () => tools.map((t) => t.toOpenAiTool());

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (ctx.stateStore.get().toolCallsUsed >= ctx.stateStore.get().toolCallBudget) break;

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
          content:
            `Optional clarification available (${decision.reason}): ${decision.detail ?? ""} ` +
            "You may call clarify, or continue.",
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
        content:
          `Status is "${status.status}" — ${status.reason} ` +
          "Continue the protocol (skim/verify/score). Do not write the final synthesis yet.",
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
  if (stateStore.get().complete) stateStore.reset(); // a finished run starts fresh

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
      { role: "user", content: question.trim() || "Understand this vault." },
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
            content:
              "Write the final one-page vault summary synthesis (2-4 sentences, " +
              `**bold** key terms) from the ledger:\n${ledger.print(5)}`,
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
