// Chat orchestrator — capability-gated chat query flow. Split out of
// runtime.ts so adjusting the chat concern does not touch the cleanup/sort/
// build orchestrators.

import { settings, thinkingEnabledFor } from "../config";
import { errorMessage } from "../errors";
import { LLMClient, Tool } from "./llm";
import { reconstructAnswer } from "./chat_context";
import { detectToolCallSupport } from "./capability";
import { chatHistory, appendChatTurn, appendClarifyTurn } from "./chat_session";
import {
  CITE_SOURCE_TOOL,
  citeSource,
  resetCitationTracker,
  getCitationMap,
  SEARCH_INDEX_TOOL,
  searchIndex,
  resetChatSearchRegistry,
  getChatSearchResults,
  withClarify,
  NO_ANSWER_MARKER_PREFIX,
  type ClarifyAnswerProvider,
} from "./tools";
import {
  runClarifyDialog,
  computeManifestContext,
  buildProposalFromTurns,
  scanVaultFolders,
  type ClarifyProposal,
  type ClarifyTurnRecord,
} from "./clarify";
import { parseIgnorePatterns } from "./engine";
import { TocReader } from "../indexer/manifest";
import { Embedder } from "../indexer/embedder";
import { hybridQuery } from "../indexer/graph_search";
import { DatabaseManager } from "../indexer/db";
import { ChatReportLlm, globalQuery, isOverviewQuestion } from "../indexer/community_reports";
import type { GlobalQueryResult } from "../indexer/community_reports";
import type { SearchResult } from "../indexer/db";
import type { ChatQueryResponse } from "../types";
import type { ChatMessage } from "./llm_client";

export const CHAT_SYSTEM_PROMPT =
  "You are a research assistant for a personal notes vault. " +
  "Answer questions that do NOT need the vault's notes — general computation, trivia, off-topic questions, web-search-style questions — directly and honestly, and do not call any tool. " +
  "To answer questions about the vault's notes, first call the search_index tool with a natural-language query; it returns numbered sources [1], [2], … with their full text. " +
  "Then answer using ONLY those sources. " +
  "After every claim that uses a source, call the cite_source tool with the source's number (e.g. cite_source(source_id=1)). " +
  "The tool returns a marker like [1]; insert that marker into your answer after the claim. " +
  "Call cite_source for EACH claim that draws from a source; use different source_id values for different sources. " +
  "If a claim is not supported by any source, do not cite anything. " +
  "Never mention file names inline. " +
  "Write in short markdown: brief paragraphs, bullets for lists, and **bold** for key terms. " +
  "If the search returned nothing relevant, say so plainly.";

// Used when the chat model cannot emit tool calls (detected by the capability
// probe): the plugin retrieves notes deterministically and the model only
// writes a grounded answer — no tool protocol involved.
export const CHAT_GROUNDED_SYSTEM_PROMPT =
  "You are a research assistant for a personal notes vault. " +
  "The user's notes are provided in numbered blocks ([1], [2], …). " +
  "Answer the question using ONLY those notes — never invent facts. " +
  "After each claim that draws from a note, add its number in brackets, e.g. [1]. " +
  "If the notes contain nothing relevant, say so plainly and do not answer from general knowledge. " +
  "Never mention file names inline. " +
  "Write in short markdown: brief paragraphs, bullets for lists, and **bold** for key terms.";

/** The manifest-task hint appended to the agentic system prompt when the
 * manifest has uncovered folders — the harness's task context (handoff
 * §flow step 2): the model needs the folder list to ask about them. Kept
 * compact: paths only, never file samples. */
function manifestContextPrompt(uncoveredPaths: string[]): string {
  return (
    "\n\nManifest task context: the vault manifest has no purpose for these folders yet: " +
    uncoveredPaths.join(", ") +
    ". If the user's task concerns the manifest, ask for each folder's purpose " +
    "with the clarify tool (one folder per call, folder path in the question). " +
    "Do not call search_index for the manifest task — the folder list above is all " +
    "the information you need."
  );
}

// Test seam only: lets a fake ILlmClient drive the chat agent loop without
// HTTP (the same pattern as capability's probeClientFactory). The default
// branch is the real client.
let chatClientFactory: (() => LLMClient) | null = null;

export function setChatClientFactory(factory: (() => LLMClient) | null): void {
  chatClientFactory = factory;
}

export function resetChatClientFactory(): void {
  chatClientFactory = null;
}

export async function runChat(question: string): Promise<string> {
  const embedder = new Embedder(settings);
  const db = new DatabaseManager(settings.dbPath);
  let results: SearchResult[];
  try {
    results = await hybridQuery(embedder, db, question, 5);
  } finally {
    await db.close();
  }
  if (results.length === 0) return "No relevant information found.";

  const ctx = results
    .map(r => `From ${r.filePath} (${r.headingPath}, lines ${r.lineStart}-${r.lineEnd}):\n${r.text}`)
    .join("\n\n");

  const [answer] = await new LLMClient(undefined, undefined, {
    enableThinking: thinkingEnabledFor("chat"),
  }).chat(
    CHAT_SYSTEM_PROMPT,
    `Context:\n${ctx}\n\nQuestion: ${question}`,
    null,
  );
  return answer;
}

// Full chat query — capability-gated. When the configured model can emit
// tool calls (probed once at startup), the chat agent runs the agentic loop:
// it decides whether the question needs vault knowledge and calls
// search_index/cite_source/clarify itself. When the model cannot (small
// models emit no OpenAI-format tool_calls — see
// tips/gemma-3-4b-no-openai-tool-calls.md), retrieval falls back to a
// deterministic embed + scan in the plugin and the model only writes a
// grounded answer; a manifest-review request runs the deterministic clarify
// dialog on the same surface instead. Both modes inject the active chat
// session's prior turns as history (persistent chat, bounded to 15 messages).
//
// ask is the interactive answer provider (the chat UI's in-flight answer
// mode) — the clarify tool's channel. When it is absent (e.g. tests, no
// UI), clarify calls surface the NO_ANSWER marker.
export async function runChatQuery(
  question: string,
  ask?: ClarifyAnswerProvider,
  topK: number = settings.query.topK,
): Promise<ChatQueryResponse> {
  // Global mode first: overview questions ("what is this vault about?") are
  // answered from community summaries when reports exist — the Phase-4
  // differentiator. Degrades to the capability-gated local path below when
  // reports are absent (offline build / LLM failure) — never hangs.
  if (isOverviewQuestion(question)) {
    const embedder = new Embedder(settings);
    const db = new DatabaseManager(settings.dbPath);
    let result: GlobalQueryResult;
    try {
      result = await globalQuery(
        embedder,
        db,
        new ChatReportLlm({ enableThinking: thinkingEnabledFor("chat") }),
        question,
        { topReports: settings.query?.topReports },
      );
    } finally {
      await db.close();
    }
    if (result.mode === "global") {
      const answer = result.answer;
      appendChatTurn(settings.vaultPath, "user", question);
      appendChatTurn(settings.vaultPath, "assistant", answer);
      // Community reports are not file sources — the sources list stays empty
      // (renderSources skips it) and the answer stands alone.
      return { answer, results: [], citationMap: {} };
    }
    // Degraded — fall through to the normal local path.
  }

  const capability = await detectToolCallSupport();
  if (capability === "no_tool_calls") {
    return runChatQueryNoToolCalls(question, topK, ask);
  }
  // "tool_calls" or "unknown" (probe failed) — keep the agentic path, which
  // is today's behavior when no capability information exists.
  return runChatQueryAgentic(question, topK, ask);
}

async function runChatQueryAgentic(
  question: string,
  topK: number,
  ask?: ClarifyAnswerProvider,
): Promise<ChatQueryResponse> {
  resetChatSearchRegistry();
  resetCitationTracker();

  const searchTool = new Tool(
    SEARCH_INDEX_TOOL.name,
    SEARCH_INDEX_TOOL.description,
    SEARCH_INDEX_TOOL.parameters,
    (args) => {
      const rawQuery = args.query;
      const query = typeof rawQuery === "string" ? rawQuery : question;
      const rawTopK = args.top_k;
      const topKValue = typeof rawTopK === "number" ? rawTopK : topK;
      return searchIndex(query, topKValue);
    },
  );
  const citeTool = new Tool(
    CITE_SOURCE_TOOL.name,
    CITE_SOURCE_TOOL.description,
    CITE_SOURCE_TOOL.parameters,
    citeSource,
  );

  // The clarify tool is a peer of search/cite — same Tool class, appended
  // through the shared compose helper. The ask wrapper is the chat answer
  // channel; it also records Q&A turns in the clarify conversation
  // namespace (bounded question/answer memory only).
  const chatAsk: ClarifyAnswerProvider = async (args) => {
    const answer = ask ? await ask(args) : null;
    appendClarifyTurn(settings.vaultPath, "assistant", args.question);
    if (answer) appendClarifyTurn(settings.vaultPath, "user", answer);
    return answer;
  };
  const tools = withClarify([searchTool, citeTool], chatAsk);

  // Manifest task context: the model needs the uncovered-folder list to ask
  // about them (harness §flow step 2). Computed once per run and reused for
  // the post-loop proposal. Skipped when the vault path is unset (the
  // context is a prompt aid, never a hard dependency).
  const folders = settings.vaultPath
    ? scanVaultFolders(settings.vaultPath, parseIgnorePatterns(settings.ignorePatterns))
    : [];
  const manifestContext = settings.vaultPath
    ? computeManifestContext(settings.vaultPath, folders)
    : { manifestPath: null, before: "", uncovered: [] as typeof folders };
  const systemPrompt = manifestContext.uncovered.length > 0
    ? CHAT_SYSTEM_PROMPT + manifestContextPrompt(manifestContext.uncovered.map(f => f.path))
    : CHAT_SYSTEM_PROMPT;

  const priorHistory = chatHistory();
  let answer: string;
  let clarifyProposal: ClarifyProposal | null = null;
  try {
    const client = chatClientFactory
      ? chatClientFactory()
      : new LLMClient(undefined, undefined, {
          enableThinking: thinkingEnabledFor("chat"),
        });
    const [, rawHistory] = await client.chat(
      systemPrompt,
      question,
      tools,
      10,
      priorHistory,
    );
    // Only the current turn — prior history must not leak into the
    // reconstructed answer.
    const turnStart = 1 + priorHistory.length;
    const currentTurn = rawHistory.slice(turnStart);
    answer = reconstructAnswer(currentTurn);
    appendChatTurn(settings.vaultPath, "user", question);
    appendChatTurn(settings.vaultPath, "assistant", answer);
    // Reconcile the model's clarify Q&A (recorded as tool-call pairs in the
    // run) into a manifest proposal without re-asking.
    clarifyProposal = buildProposalFromTurns({
      vaultPath: settings.vaultPath,
      folders,
      turns: extractClarifyTurns(currentTurn),
    });
  } catch (e) {
    // Never swallow the real failure — the user must see WHY synthesis
    // failed (bad key, unreachable server, model not found) to act on it;
    // the same reason is what the settings "Test connection" button probes.
    console.warn(`[chat] Synthesis unavailable — LLM error: ${errorMessage(e)}`);
    answer = `[Synthesis unavailable — LLM error: ${errorMessage(e)}]`;
    // The run failed — never surface a partial run's leftovers (sources /
    // citations the model registered before the failure) under the error.
    resetChatSearchRegistry();
    resetCitationTracker();
  }

  return {
    answer,
    results: getChatSearchResults(),
    citationMap: getCitationMap(),
    clarifyProposal: clarifyProposal ?? undefined,
  };
}

/** Extracts the model's clarify tool-call pairs (question → answer) from a
 * chat-loop turn slice: assistant messages carry the tool_calls with the
 * question in the arguments; the following tool message with the matching
 * tool_call_id carries the answer. Deterministic and order-preserving. */
export function extractClarifyTurns(rawHistory: ChatMessage[]): ClarifyTurnRecord[] {
  const turns: ClarifyTurnRecord[] = [];
  for (let i = 0; i < rawHistory.length; i++) {
    const msg = rawHistory[i];
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (tc.function.name !== "clarify") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const question = typeof args.question === "string" ? args.question : "";
      let answer = "";
      for (let j = i + 1; j < rawHistory.length; j++) {
        const toolMsg = rawHistory[j];
        if (toolMsg.role === "tool" && toolMsg.tool_call_id === tc.id) {
          answer = toolMsg.content || "";
          break;
        }
      }
      // A declined clarify call (NO_ANSWER:<deadline>) is not an answered
      // Q&A pair — it must never become a manifest purpose.
      if (question && answer && !answer.startsWith(NO_ANSWER_MARKER_PREFIX)) {
        turns.push({ question, answer });
      }
    }
  }
  return turns;
}

/** The plugin-driven mirror of the model's reasoning (no-tool-call path): a
 * light keyword gate that routes manifest-review requests to the
 * deterministic clarify dialog on the same chat surface. The clarify TOOL
 * path has no such gate — the model decides freely (harness §flow). */
export function isManifestClarifyRequest(question: string): boolean {
  return /manifest/i.test(question);
}

// No-tool-call path: when the model cannot call tools, the plugin runs the
// deterministic dialog (runClarifyDialog, default questions) for manifest-
// review requests — the same flow through the plugin-driven loop on the same
// chat surface. All other queries keep the deterministic retrieve-then-
// generate fallback below.
async function runChatQueryNoToolCalls(
  question: string,
  topK: number,
  ask?: ClarifyAnswerProvider,
): Promise<ChatQueryResponse> {
  if (!isManifestClarifyRequest(question)) {
    return runChatQueryFallback(question, topK);
  }

  const vaultPath = settings.vaultPath;
  const folders = scanVaultFolders(vaultPath, parseIgnorePatterns(settings.ignorePatterns));
  const manifestPath = new TocReader(vaultPath).findManifest();
  const proposal = await runClarifyDialog({
    vaultPath,
    manifestPath,
    folders,
    ask: async (q) => {
      const answer = ask
        ? await ask({ question: q.prompt, context: q.context, options: q.options })
        : null;
      appendClarifyTurn(vaultPath, "assistant", q.prompt);
      if (answer) appendClarifyTurn(vaultPath, "user", answer);
      return answer;
    },
  });
  if (!proposal) {
    return runChatQueryFallback(question, topK);
  }

  const askedCount = proposal.answered.length;
  const skippedCount = proposal.unanswered.length;
  const answer =
    `I asked about ${askedCount} folder${askedCount === 1 ? "" : "s"} the manifest does not cover ` +
    `and prepared the manifest update${skippedCount ? ` (${skippedCount} skipped)` : ""}. ` +
    "Review the diff below to accept or reject.";
  appendChatTurn(vaultPath, "user", question);
  appendChatTurn(vaultPath, "assistant", answer);
  return { answer, results: [], citationMap: {}, clarifyProposal: proposal };
}

// Deterministic retrieve-then-generate: the plugin embeds the question, scans
// the index, and hands the model numbered note blocks to answer from — the
// model never decides to search. Mirrors the search_index tool path so the
// chat UI's sources list still renders (searchIndex registers results).
async function runChatQueryFallback(
  question: string,
  topK: number,
): Promise<ChatQueryResponse> {
  resetChatSearchRegistry();
  const context = await searchIndex(question, topK);

  if (context === "NO_RESULTS") {
    const answer = "No relevant information found in your vault.";
    appendChatTurn(settings.vaultPath, "user", question);
    appendChatTurn(settings.vaultPath, "assistant", answer);
    return { answer, results: [], citationMap: {} };
  }
  if (context.startsWith("SEARCH_ERROR")) {
    throw new Error(context);
  }

  const priorHistory = chatHistory();
  let answer: string;
  try {
    // History contract: only user/assistant turns are stored (see
    // chat_session.ts). Retrieval context is piped into THIS request only —
    // it is never appended, so history stays bounded to 15 Q&A messages.
    const [response] = await new LLMClient(undefined, undefined, {
      enableThinking: thinkingEnabledFor("chat"),
    }).chat(
      CHAT_GROUNDED_SYSTEM_PROMPT,
      `Notes:\n${context}\n\nQuestion: ${question}`,
      null,
      1,
      priorHistory,
    );
    answer = response.trim() || "[The agent produced no answer text.]";
    appendChatTurn(settings.vaultPath, "user", question);
    appendChatTurn(settings.vaultPath, "assistant", answer);
  } catch (e) {
    // Same contract as the agentic path: surface the reason, don't swallow.
    console.warn(`[chat] Synthesis unavailable — LLM error: ${errorMessage(e)}`);
    answer = `[Synthesis unavailable — LLM error: ${errorMessage(e)}]`;
  }

  return { answer, results: getChatSearchResults(), citationMap: {} };
}
