// Tool implementations for the agent runtime.
// Ported from src/agent/tools.py

import * as crypto from "crypto";
import * as path from "path";
import { settings } from "../config";
import { errorMessage } from "../errors";
import {
  FileRegistry,
  Receipt,
  Snapshot,
  Validators,
  parseIgnorePatterns,
} from "./engine";
import { Embedder } from "../indexer/embedder";
import { DatabaseManager } from "../indexer/db";
import { hybridQuery } from "../indexer/graph_search";
import type { SearchResult } from "../indexer/db";
import { buildChatContext } from "./chat_context";
import { applyOps } from "./tools_apply_edits";
import type { ApplyEditsArgs } from "./tools_apply_edits";
import { Tool } from "./llm";
// Re-export the wire shapes so importers (engine.ts, tests) keep their paths.
export type { EditOp, OpAnchor, ApplyEditsArgs } from "./tools_apply_edits";
import type { ChatQueryResult } from "../types";

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

let registry: FileRegistry | null = null;
let lastPreviewResult = "";

export function getRegistry(): FileRegistry {
  if (!registry) {
    let vault = settings.vaultPath;
    if (!path.isAbsolute(vault)) {
      vault = path.resolve(vault);
    }
    registry = new FileRegistry(path.resolve(vault), null, parseIgnorePatterns(settings.ignorePatterns));
  }
  return registry;
}

export function resetRegistry(): void {
  registry = null;
}

export function getLastPreviewResult(): string {
  return lastPreviewResult;
}

export function resetPreviewResult(): void {
  lastPreviewResult = "";
}

export function setRegistryAllowedPrefixes(prefixes: string[]): void {
  const reg = getRegistry();
  reg.allowedPrefixes = prefixes;
}

// ---------------------------------------------------------------------------
// Discovery tools
// ---------------------------------------------------------------------------

export function listFiles(relPath: string = ""): string {
  return getRegistry().listFiles(relPath);
}

export function findInbox(): string {
  return getRegistry().findInbox();
}

export function searchFiles(query: string): string {
  return getRegistry().searchFiles(query);
}

export function readFile(handle: string): string {
  return getRegistry().readFile(handle);
}

export function fileStat(handle: string): string {
  try {
    const info = getRegistry().fileStat(handle);
    return `handle=${info.handle} path=${info.relative} size=${info.size} hash=${info.hash} lines=${info.lineCount}`;
  } catch (e) {
    return `STAT_ERROR: ${errorMessage(e)}`;
  }
}

// ---------------------------------------------------------------------------
// Search index — the agent-driven retrieval tool.
//
// The chat agent decides when retrieval is needed: the embedding round trip
// + full-table vector scan only run when the agent calls search_index (or a
// simple question is answered directly with no tools at all). Results are
// REGISTERED so the chat UI can render sources + citations, and returned to
// the model as numbered full-text blocks ([1], [2], …) to answer and cite
// against.
// ---------------------------------------------------------------------------

let chatSearchResults: ChatQueryResult[] = [];

export function resetChatSearchRegistry(): void {
  chatSearchResults = [];
}

export function getChatSearchResults(): ChatQueryResult[] {
  return chatSearchResults;
}

export async function searchIndex(query: string, topK: number = settings.query.topK): Promise<string> {
  try {
    const embedder = new Embedder(settings);
    const db = new DatabaseManager(settings.dbPath);
    let results: SearchResult[];
    try {
      // Hybrid local search (cosine + graph expansion) — the chat retrieval
      // path; clean/sort stay on pure cosine until the merged ranking is
      // validated (handoff Phase 1 wiring decision).
      results = await hybridQuery(embedder, db, query, topK);
    } finally {
      await db.close();
    }
    if (results.length === 0) {
      chatSearchResults = [];
      return "NO_RESULTS";
    }

    chatSearchResults = results.map(r => ({
      node_key: r.nodeKey,
      file_path: r.filePath,
      heading_path: r.headingPath,
      score: r.score,
      text: r.text,
      line_start: r.lineStart,
      line_end: r.lineEnd,
    }));
    return buildChatContext(chatSearchResults);
  } catch (e) {
    chatSearchResults = [];
    return `SEARCH_ERROR: ${errorMessage(e)}`;
  }
}

// ---------------------------------------------------------------------------
// apply_edits — the ONLY mutation tool
// ---------------------------------------------------------------------------

// Edit application — the pure op pipeline lives in tools_apply_edits.ts
// (applyOps); the wire boundary stays here: resolve the handle, snapshot,
// run ops, write (or preview), validate, and return a receipt.

export function applyEdits(args: Record<string, unknown>): string {
  const { handle, ops } = args as unknown as ApplyEditsArgs;
  const reg = getRegistry();
  let filePath: string;
  try {
    filePath = reg.resolve(handle);
  } catch (e) {
    return `RESOLVE_ERROR: ${errorMessage(e)}`;
  }

  // Snapshot before
  const before = Snapshot.take(filePath, reg.io);
  const applied = applyOps(ops, before.content.split("\n"));

  if (applied.rejected.length > 0 && applied.validOps.length === 0) {
    return JSON.stringify({
      error: "ALL_OPS_REJECTED",
      rejected: applied.rejected,
      file_unchanged: true,
    });
  }

  // Write result atomically (confined to the vault)
  const result = applied.lines.join("\n");
  const rel = path.relative(reg.vaultRoot, filePath);
  reg.io.writeTextAtomic(rel, result);

  // Snapshot after
  const after = Snapshot.take(filePath, reg.io);

  const validationResults: Record<string, [boolean, string]> = {
    word_conservation: Validators.wordConservation(before.content, result, applied.sanctionWords),
    headers_preserved: Validators.headersPreserved(before.content, result),
    protected_spans: Validators.protectedSpansIntact(before.content, result),
    join_punctuation: Validators.joinPunctuation(applied.validOps, applied.lines),
  };

  const receipt = Receipt.create(
    handle,
    before.hash,
    after.hash,
    applied.validOps.length,
    applied.rejected.length,
    applied.diffStat,
    validationResults,
  );

  // Store result text
  lastPreviewResult = result;

  return JSON.stringify(receipt.toDict(), null, 2);
}

// ---------------------------------------------------------------------------
// apply_edits_impl — compute receipt without writing to disk
// ---------------------------------------------------------------------------

export function applyEditsImpl(args: Record<string, unknown>): string {
  const { handle, ops } = args as unknown as ApplyEditsArgs;
  const reg = getRegistry();
  let filePath: string;
  try {
    filePath = reg.resolve(handle);
  } catch (e) {
    return `RESOLVE_ERROR: ${errorMessage(e)}`;
  }

  const before = Snapshot.take(filePath, reg.io);
  const applied = applyOps(ops, before.content.split("\n"));

  if (applied.rejected.length > 0 && applied.validOps.length === 0) {
    lastPreviewResult = before.content;
    return JSON.stringify({
      error: "ALL_OPS_REJECTED",
      rejected: applied.rejected,
      file_unchanged: true,
    });
  }

  const result = applied.lines.join("\n");
  const afterHash = crypto.createHash("sha1").update(result).digest("hex").slice(0, 12);

  const validationResults: Record<string, [boolean, string]> = {
    word_conservation: Validators.wordConservation(before.content, result, applied.sanctionWords),
    headers_preserved: Validators.headersPreserved(before.content, result),
    protected_spans: Validators.protectedSpansIntact(before.content, result),
    join_punctuation: Validators.joinPunctuation(applied.validOps, applied.lines),
  };

  const receipt = Receipt.create(
    handle,
    before.hash,
    afterHash,
    applied.validOps.length,
    applied.rejected.length,
    applied.diffStat,
    validationResults,
  );

  lastPreviewResult = result;

  return JSON.stringify(receipt.toDict(), null, 2);
}


// Tool schemas
// ---------------------------------------------------------------------------

export const LIST_FILES_TOOL = {
  name: "list_files",
  description: "List files and folders in a vault directory. Returns handles like f_0001.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to vault root (default: root).",
      },
    },
  },
};

export const FIND_INBOX_TOOL = {
  name: "find_inbox",
  description: "Find the inbox folder and list its contents with handles.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export const SEARCH_FILES_TOOL = {
  name: "search_files",
  description: "Search for files by name. Returns matching handles.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filename search term." },
    },
    required: ["query"],
  },
};

export const READ_FILE_TOOL = {
  name: "read_file",
  description: "Read a file by its handle. Returns content with line numbers. Use this BEFORE apply_edits.",
  parameters: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "File handle (e.g. f_0001). Get handles from list_files or find_inbox.",
      },
    },
    required: ["handle"],
  },
};

export const FILE_STAT_TOOL = {
  name: "file_stat",
  description: "Get file metadata for a handle (size, hash, line count).",
  parameters: {
    type: "object",
    properties: {
      handle: { type: "string", description: "File handle." },
    },
    required: ["handle"],
  },
};

export const SEARCH_INDEX_TOOL = {
  name: "search_index",
  description: "Search the knowledge base. Returns relevant sections with file handles.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query." },
      top_k: { type: "integer", description: "Results count.", default: 5 },
    },
    required: ["query"],
  },
};

export const APPLY_EDITS_TOOL = {
  name: "apply_edits",
  description: "Apply edit operations to a file. Read the file first with read_file to get line numbers. Returns a RECEIPT — if no receipt appears, the write did NOT happen.",
  parameters: {
    type: "object",
    properties: {
      handle: { type: "string", description: "File handle (e.g. f_0001)." },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["join_lines", "insert_header", "remove_span", "collapse_blanks", "insert_flag"],
              description: "Operation type.",
            },
            anchor: {
              type: "object",
              properties: {
                start: { type: "integer", description: "Start line (1-indexed)." },
                end: { type: "integer", description: "End line (1-indexed)." },
                before_line: { type: "integer", description: "Insert before this line." },
              },
            },
            text: { type: "string", description: "Text for insert_header." },
            kind: {
              type: "string",
              enum: ["tag", "properties_block"],
              description: "Kind for remove_span.",
            },
            reason: { type: "string", description: "Reason for insert_flag." },
          },
          required: ["op", "anchor"],
        },
      },
    },
    required: ["handle", "ops"],
  },
};

// ---------------------------------------------------------------------------
// Cite-source tool — deterministic citation numbering for the chat agent.
// The agent calls cite_source(source_id) and the tool assigns a stable
// [N] marker: increments on the first citation of each source, returns the
// same number on subsequent citations of the same source.  This keeps the
// answer text free of self-managed numbering.
// ---------------------------------------------------------------------------

export const CITE_SOURCE_TOOL = {
  name: "cite_source",
  description:
    "Cite a source by its number from the Context. " +
    "Call this after every claim that uses a source — the tool returns a citation marker like [1]. " +
    "Insert the returned marker directly into your answer text after the claim. " +
    "The same source always gets the same marker number.",
  parameters: {
    type: "object",
    properties: {
      source_id: {
        type: "integer",
        description:
          "The source number from the Context (e.g., 1 for [1], 2 for [2]). " +
          "Must be a numbered source that exists in the Context.",
      },
    },
    required: ["source_id"],
  },
};

let citationCounter = 0;
const citationIndexMap = new Map<number, number>();

export function resetCitationTracker(): void {
  citationCounter = 0;
  citationIndexMap.clear();
}

export interface CiteSourceArgs {
  source_id: number;
}

export function citeSource(args: Record<string, unknown>): string {
  const sourceId = Number((args as unknown as CiteSourceArgs).source_id);
  if (!Number.isFinite(sourceId) || sourceId < 1) {
    return "Error: source_id must be a positive integer";
  }
  const sourceIndex = sourceId - 1;
  let citationNumber = citationIndexMap.get(sourceIndex);
  if (citationNumber === undefined) {
    citationNumber = ++citationCounter;
    citationIndexMap.set(sourceIndex, citationNumber);
  }
  return `[${citationNumber}]`;
}

/** Returns a snapshot: citation-number → source-index (0‑based into results). */
export function getCitationMap(): Record<number, number> {
  const result: Record<number, number> = {};
  for (const [srcIdx, citNum] of citationIndexMap) {
    result[citNum] = srcIdx;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Clarify tool — ask the user a short, self-contained question when evidence
// is ambiguous (low confidence, unknown folder purpose, missing destination).
// The dialog driver registers an answer provider (the UI asker, the LLM loop
// channel, …); the tool itself never writes — answers land only in the
// caller's flow. A null answer (deadline / user skip / no provider) surfaces
// as the NO_ANSWER:<deadline> marker so the caller can fall back.
// ---------------------------------------------------------------------------

export const CLARIFY_TOOL = {
  name: "clarify",
  description:
    "Ask the user a short clarifying question when you need their input to " +
    "continue — ambiguous evidence, an intent you cannot infer, a decision " +
    "only the user can make. Make the question self-contained: include the " +
    "context the user needs. Returns the user's answer verbatim, or a " +
    "NO_ANSWER:<deadline> marker when the user does not answer. Use at most " +
    "a few times per task.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "One clear question the user can answer in a few words.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional closed answer choices.",
      },
      context: {
        type: "string",
        description: "The context the user needs to answer. Do not rely on history.",
      },
      deadline: {
        type: "string",
        description: "ISO timestamp echoed in the NO_ANSWER marker when the user does not answer.",
      },
    },
    required: ["question"],
  },
};

export interface ClarifyArgs {
  question: string;
  options?: string[];
  context?: string;
  deadline?: string;
}

/** The marker a declined clarify call returns — the caller falls back
 * (manifest: the folder is left uncovered). Shared by the tool, the turn
 * extraction, and the deadline semantics. */
export const NO_ANSWER_MARKER_PREFIX = "NO_ANSWER:";

/** Returns the answer verbatim, or null when the user did not answer. */
export type ClarifyAnswerProvider = (
  args: ClarifyArgs,
) => string | null | Promise<string | null>;

let clarifyAnswerProvider: ClarifyAnswerProvider | null = null;

export function setClarifyAnswerProvider(provider: ClarifyAnswerProvider | null): void {
  clarifyAnswerProvider = provider;
}

export function resetClarifyAnswerProvider(): void {
  clarifyAnswerProvider = null;
}

/** The shared clarify implementation — resolves the answer through the given
 * provider (or the NO_ANSWER:<deadline> marker when the provider is null /
 * declines). withClarify() and the global clarify() entry both delegate
 * here, so the tool contract stays in ONE place. */
export async function clarifyWith(
  args: Record<string, unknown>,
  provider: ClarifyAnswerProvider | null,
): Promise<string> {
  const { question, options, context, deadline } = args as unknown as ClarifyArgs;
  if (typeof question !== "string" || !question.trim()) {
    return "Error: question must be a non-empty string";
  }
  if (!provider) {
    return `${NO_ANSWER_MARKER_PREFIX}${deadline || "unavailable"}`;
  }
  const answer = await provider({ question, options, context, deadline });
  if (answer == null) {
    return `${NO_ANSWER_MARKER_PREFIX}${deadline || "unavailable"}`;
  }
  return answer;
}

export async function clarify(args: Record<string, unknown>): Promise<string> {
  return clarifyWith(args, clarifyAnswerProvider);
}

/** Appends the `clarify` Tool to a loop's existing tools array — the shared
 * compose helper every consumer (chat: search + cite + clarify; cleanup:
 * apply_edits + clarify; sort: apply_edits + clarify) uses so the grouping
 * is uniform: same Tool class, same OpenAI serialization, no separate
 * mechanism. The tool is simply present; the model calls it at its
 * discretion (no intent-detection gate). */
export function withClarify(tools: Tool[], askProvider: ClarifyAnswerProvider): Tool[] {
  return [
    ...tools,
    new Tool(
      CLARIFY_TOOL.name,
      CLARIFY_TOOL.description,
      CLARIFY_TOOL.parameters,
      (args) => clarifyWith(args, askProvider),
    ),
  ];
}
