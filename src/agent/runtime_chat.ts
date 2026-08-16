// Chat orchestrator — capability-gated chat query flow. Split out of
// runtime.ts so adjusting the chat concern does not touch the cleanup/sort/
// build orchestrators.

import { settings } from "../config";
import { LLMClient, Tool } from "./llm";
import { reconstructAnswer } from "./chat_context";
import { detectToolCallSupport } from "./capability";
import { chatHistory, appendChatTurn } from "./chat_session";
import {
  CITE_SOURCE_TOOL,
  citeSource,
  resetCitationTracker,
  getCitationMap,
  SEARCH_INDEX_TOOL,
  searchIndex,
  resetChatSearchRegistry,
  getChatSearchResults,
} from "./tools";
import { Embedder } from "../indexer/embedder";
import { hybridQuery } from "../indexer/graph_search";
import { DatabaseManager } from "../indexer/db";
import type { SearchResult } from "../indexer/db";
import type { ChatQueryResponse } from "../types";

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

  const [answer] = await new LLMClient().chat(
    CHAT_SYSTEM_PROMPT,
    `Context:\n${ctx}\n\nQuestion: ${question}`,
    null,
  );
  return answer;
}

// Full chat query — capability-gated. When the configured model can emit
// tool calls (probed once at startup), the chat agent runs the agentic loop:
// it decides whether the question needs vault knowledge and calls
// search_index/cite_source itself. When the model cannot (small models emit
// no OpenAI-format tool_calls — see tips/gemma-3-4b-no-openai-tool-calls.md),
// retrieval falls back to a deterministic embed + scan in the plugin and the
// model only writes a grounded answer. Both modes inject the active chat
// session's prior turns as history (persistent chat, bounded to 15 messages).
export async function runChatQuery(
  question: string,
  topK: number = 5,
): Promise<ChatQueryResponse> {
  const capability = await detectToolCallSupport();
  if (capability === "no_tool_calls") {
    return runChatQueryFallback(question, topK);
  }
  // "tool_calls" or "unknown" (probe failed) — keep the agentic path, which
  // is today's behavior when no capability information exists.
  return runChatQueryAgentic(question, topK);
}

async function runChatQueryAgentic(
  question: string,
  topK: number,
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

  const priorHistory = chatHistory();
  let answer: string;
  try {
    const [, rawHistory] = await new LLMClient().chat(
      CHAT_SYSTEM_PROMPT,
      question,
      [searchTool, citeTool],
      10,
      priorHistory,
    );
    // Only the current turn — prior history must not leak into the
    // reconstructed answer.
    const turnStart = 1 + priorHistory.length;
    answer = reconstructAnswer(rawHistory.slice(turnStart));
    appendChatTurn(settings.vaultPath, "user", question);
    appendChatTurn(settings.vaultPath, "assistant", answer);
  } catch {
    answer = "[Synthesis unavailable — LLM error]";
  }

  return { answer, results: getChatSearchResults(), citationMap: getCitationMap() };
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
    const [response] = await new LLMClient().chat(
      CHAT_GROUNDED_SYSTEM_PROMPT,
      `Notes:\n${context}\n\nQuestion: ${question}`,
      null,
      1,
      priorHistory,
    );
    answer = response.trim() || "[The agent produced no answer text.]";
    appendChatTurn(settings.vaultPath, "user", question);
    appendChatTurn(settings.vaultPath, "assistant", answer);
  } catch {
    answer = "[Synthesis unavailable — LLM error]";
  }

  return { answer, results: getChatSearchResults(), citationMap: {} };
}
