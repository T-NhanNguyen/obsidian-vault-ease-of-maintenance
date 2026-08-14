// Agent Runtime — orchestrator for cleanup, sort, chat, and build.
// Ported from src/agent/runtime.py

import * as crypto from "crypto";
import * as path from "path";
import { settings, INDEX_DB_SUFFIX } from "../config";
import { VaultIO } from "../io/vault_io";
import { errorMessage } from "../errors";
import { LLMClient, Tool } from "./llm";
import { reconstructAnswer } from "./chat_context";
import { detectToolCallSupport } from "./capability";
import { chatHistory, appendChatTurn } from "./chat_session";
import * as toolImpl from "./tools";
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
import cleanupSkillMd from "../../maintainer-definitions/phase-1-note-cleanup.md";
import {
  ELIGIBLE,
  NEAR_DUP,
  EligibilityFilter,
  Journal,
  JournalEntry,
  OperationContext,
  Validators,
  isIgnored,
  parseIgnorePatterns,
  tokenizeWords,
} from "./engine";
import { Embedder } from "../indexer/embedder";
import { Indexer } from "../indexer/indexer";
import { DatabaseManager } from "../indexer/db";
import type { ChatMessage } from "./llm_client";
import { ManifestEntry, ManifestParser, TocReader } from "../indexer/manifest";
import type { ChatQueryResponse } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLEANUP_SKILL_FILENAME = "phase-1-note-cleanup.md";
const SORT_BUDGET_TOTAL = 240;
const FALLBACK_CONFIDENCE_FLOOR = 0.6;
const REWRITE_CONTENT_THRESHOLD = 0.2;

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

// ---------------------------------------------------------------------------
// Skill loading
// ---------------------------------------------------------------------------

function loadSkill(skillName: string): string {
  // Skills are bundled at build time via esbuild's text loader (.md → text).
  // Runtime disk reads are unreliable inside Obsidian (no __dirname), so the
  // skill content ships inside main.js — no pathing to go wrong.
  if (skillName === CLEANUP_SKILL_FILENAME) return cleanupSkillMd;
  return `# ${skillName}\n\n(Skill file not found)`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Receipt JSON returned by apply_edits on the tool-call path (see tools.ts).
interface EditReceipt {
  receipt_id?: string;
  error?: string;
  rejected?: Array<{ op: string; reason: string }>;
  ops_applied?: number;
  ops_rejected?: number;
  validation?: {
    passed?: boolean;
    checks?: Record<string, string>;
  };
  hash_before?: string;
  hash_after?: string;
}

function collectReceipts(history: ChatMessage[]): EditReceipt[] {
  const receipts: EditReceipt[] = [];
  for (const msg of history) {
    if (msg.role === "tool" && msg.content) {
      const c = msg.content.trim();
      if (c.startsWith("{")) {
        try {
          const d = JSON.parse(c) as EditReceipt;
          if (d.receipt_id) receipts.push(d);
        } catch { /* ignore */ }
      }
    }
  }
  return receipts;
}

function pathFor(handle: string): string {
  const reg = toolImpl.getRegistry();
  try {
    return path.relative(reg.vaultRoot, reg.resolve(handle));
  } catch {
    return handle;
  }
}

// ---------------------------------------------------------------------------
// ProposedChange — mirrors Python dataclass
// ---------------------------------------------------------------------------

export interface ProposedChange {
  filePath: string;
  vaultPath: string;
  original: string;
  cleaned: string;
  validation: Record<string, [boolean, string]>;
  opsApplied: number;
  opsRejected: number;
  changed: boolean;
}

function makeProposedChange(
  filePath: string,
  vaultPath: string,
  original: string,
  cleaned: string,
  validation: Record<string, [boolean, string]>,
  opsApplied: number = 0,
  opsRejected: number = 0,
): ProposedChange {
  return {
    filePath,
    vaultPath,
    original,
    cleaned,
    validation,
    opsApplied,
    opsRejected,
    changed: original !== cleaned,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: clean
// ---------------------------------------------------------------------------

export async function runCleanup(
  filePath: string,
  vaultPath?: string,
  preview: boolean = true,
): Promise<ProposedChange | string> {
  if (vaultPath) {
    settings.vaultPath = vaultPath;
    settings.dbPath = path.join(vaultPath, INDEX_DB_SUFFIX);
    toolImpl.resetRegistry();
  }

  const reg = toolImpl.getRegistry();
  const vault = reg.vaultRoot;
  const io = reg.io;
  const rel = path.isAbsolute(filePath)
    ? path.relative(vault, filePath)
    : filePath.replace(/\\/g, "/");

  const original = io.readText(rel);
  const beforeHash = crypto.createHash("sha1").update(original).digest("hex").slice(0, 12);

  const skill = loadSkill(CLEANUP_SKILL_FILENAME);
  const system =
    "You are a note cleanup assistant. Follow these cleanup rules EXACTLY:\n" +
    `${skill}\n\n` +
    "Here is the file to clean. Apply edits using the apply_edits tool:\n" +
    "  1. Call apply_edits with line-numbered ops (join_lines, insert_header, etc.)\n" +
    "  2. If apply_edits is unavailable, return the COMPLETE cleaned file as text.\n" +
    "Prefer apply_edits — it is receipt-verified and safer.\n" +
    "Preserve all headers, code blocks, images, links, and tables exactly as-is.";

  const filename = path.basename(filePath);
  const user = `Clean this file (${filename}). The full content is below:\n\n\`\`\`\n${original}\n\`\`\``;

  const tools = [
    new Tool(
      toolImpl.APPLY_EDITS_TOOL.name,
      toolImpl.APPLY_EDITS_TOOL.description,
      toolImpl.APPLY_EDITS_TOOL.parameters,
      toolImpl.applyEdits,
    ),
  ];

  const client = new LLMClient();
  toolImpl.resetPreviewResult();
  const [response, history] = await client.chat(system, user, tools, 3);

  // Receipt path
  const receipts = collectReceipts(history);
  if (receipts.length > 0) {
    const r = receipts[receipts.length - 1];
    if (r.error === "ALL_OPS_REJECTED") {
      return preview
        ? makeProposedChange(filePath, settings.vaultPath, original, original, {
            word_conservation: [true, "word_conservation: pass"],
            headers_preserved: [true, "headers_preserved: pass"],
            protected_spans: [true, "protected_spans: pass"],
          }, 0, r.rejected?.length || 0)
        : "No changes made (all ops rejected).";
    }

    if (preview) {
      const cleaned = toolImpl.getLastPreviewResult();
      const checks = r.validation?.checks || {};
      const validation: Record<string, [boolean, string]> = {};
      for (const [k, v] of Object.entries(checks)) {
        const passed = v.endsWith(": pass");
        validation[k] = [passed, v];
      }

      // Revert file to original
      io.writeTextAtomic(rel, original);

      return makeProposedChange(
        filePath, settings.vaultPath, original, cleaned,
        validation, r.ops_applied || 0, r.ops_rejected || 0,
      );
    } else {
      // Legacy path
      if (!r.validation?.passed) {
        const fails = Object.entries(r.validation?.checks || {})
          .filter(([k, v]) => !v.startsWith(k + ": pass"))
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join("\n");
        const warnings = `<!-- ⚠ Cleanup warnings:\n${fails}\n-->\n\n`;
        prependToFile(io, rel, warnings);
        const afterContent = io.readText(rel);
        const afterHash = crypto.createHash("sha1").update(afterContent).digest("hex").slice(0, 12);
        return (
          `Cleanup complete (via apply_edits, with warnings).\n` +
          `Ops: ${r.ops_applied} applied, ${r.ops_rejected} rejected\n` +
          `Hash: ${beforeHash} -> ${afterHash}\n` +
          `Warnings prepended to top of file.`
        );
      }
      return (
        `Cleanup complete (via apply_edits).\n` +
        `Ops: ${r.ops_applied} applied, ${r.ops_rejected} rejected\n` +
        `Hash: ${r.hash_before} -> ${r.hash_after}\n` +
        `Validation: PASS`
      );
    }
  }

  // Full rewrite path
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    const idx = cleaned.indexOf("\n");
    if (idx !== -1) cleaned = cleaned.slice(idx + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trimEnd();
    else if (cleaned.includes("\n```")) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf("\n```")).trimEnd();
    }
  }

  if (!cleaned || cleaned === original) {
    const msg = "No changes made (file unchanged).";
    if (preview) {
      return makeProposedChange(filePath, settings.vaultPath, original, original, {
        word_conservation: [true, "word_conservation: pass"],
        headers_preserved: [true, "headers_preserved: pass"],
        protected_spans: [true, "protected_spans: pass"],
      });
    }
    return msg;
  }

  // Sanity check
  const origWords = tokenizeWords(original).length;
  const cleanWords = tokenizeWords(cleaned).length;
  if (cleanWords < origWords * REWRITE_CONTENT_THRESHOLD) {
    const msg = `Cleanup SKIPPED — model returned commentary instead of a cleaned file.`;
    if (preview) {
      return makeProposedChange(filePath, settings.vaultPath, original, original, {
        word_conservation: [true, "word_conservation: pass"],
        headers_preserved: [true, "headers_preserved: pass"],
        protected_spans: [true, "protected_spans: pass"],
      }, 0, 0);
    }
    return msg;
  }

  const validation: Record<string, [boolean, string]> = {
    word_conservation: Validators.wordConservation(original, cleaned),
    headers_preserved: Validators.headersPreserved(original, cleaned),
    protected_spans: Validators.protectedSpansIntact(original, cleaned),
  };

  if (preview) {
    return makeProposedChange(filePath, settings.vaultPath, original, cleaned, validation);
  }

  // Legacy: write the file
  io.writeTextAtomic(rel, cleaned);

  const allOk = Object.values(validation).every(v => v[0]);
  if (!allOk) {
    const fails = Object.entries(validation)
      .filter(([, v]) => !v[0])
      .map(([k, v]) => `  - ${k}: ${v[1]}`)
      .join("\n");
    const warnings = `<!-- ⚠ Cleanup warnings:\n${fails}\n-->\n\n`;
    prependToFile(io, rel, warnings);
  }

  return `Cleanup complete (full rewrite).\nSize: ${original.length} -> ${cleaned.length} bytes\nHash: ${beforeHash} -> ${crypto.createHash("sha1").update(cleaned).digest("hex").slice(0, 12)}${allOk ? "\nValidation: PASS" : "\nWarnings prepended to top of file."}`;
}

// ---------------------------------------------------------------------------
// Sort result types
// ---------------------------------------------------------------------------

export interface SortDecision {
  unitId: string;
  sourceHandle: string;
  sourcePath: string;
  sourceContent: string;
  action: string;
  score: number;
  reason: string;
  destPath: string;
  destHeading: string;
  destContextBefore: string;
  destContextAfter: string;
}

export class SortResult {
  constructor(
    public decisions: SortDecision[] = [],
    public manifestConstitution: string = "",
    public suggestions: string = "",
    public elapsed: number = 0,
  ) {}

  get placed(): SortDecision[] {
    return this.decisions.filter(d => d.action === "placed");
  }

  get flagged(): SortDecision[] {
    return this.decisions.filter(d => ["flagged", "near_duplicate", "no_destination"].includes(d.action));
  }

  toReport(): string {
    const lines = [
      `Sort completed in ${Math.round(this.elapsed)}s.`,
      `${this.placed.length} placed, ${this.flagged.length} flagged.`,
    ];
    for (const d of this.decisions) {
      if (d.action === "placed") {
        lines.push(`  ${d.sourcePath} -> ${d.destPath} (score=${d.score.toFixed(2)})`);
      } else if (d.action === "near_duplicate") {
        lines.push(`  ${d.sourcePath}: near-duplicate at ${d.destPath}`);
      } else if (d.action === "no_destination") {
        lines.push(`  ${d.sourcePath}: no eligible candidates`);
      } else {
        lines.push(`  ${d.sourcePath}: ${d.reason}`);
      }
    }
    if (this.suggestions) {
      lines.push(`\nSuggestions:\n${this.suggestions}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Orchestrator: sort
// ---------------------------------------------------------------------------

export async function runTriage(
  vaultPath?: string,
  inboxFolder?: string,
): Promise<SortResult | string> {
  toolImpl.resetRegistry();
  if (vaultPath) {
    settings.vaultPath = vaultPath;
    settings.dbPath = path.join(vaultPath, INDEX_DB_SUFFIX);
  }

  const startTime = Date.now();
  const journal = new Journal();
  const inboxSnapshot = new Map<string, string>();

  let inboxInfo: string;
  if (inboxFolder) {
    inboxInfo = toolImpl.listFiles(inboxFolder);
    if (inboxInfo.startsWith("DIR_NOT_FOUND")) {
      return `Inbox folder not found: ${inboxFolder}`;
    }
  } else {
    inboxInfo = toolImpl.findInbox();
    if (inboxInfo.startsWith("NO_INBOX")) {
      return `Inbox not found.\n${inboxInfo}`;
    }
  }

  const manifestConstitution = loadManifestConstitution();
  const inboxFiles = inboxInfo.match(/f_\d{4}/g) || [];
  const units = discoverUnits(inboxFiles);
  if (units.length === 0) return "Inbox is empty.";

  // Snapshot inbox state
  const reg = toolImpl.getRegistry();
  for (const h of inboxFiles) {
    try {
      const p = reg.resolve(h);
      const rel = path.relative(reg.vaultRoot, p);
      inboxSnapshot.set(h, crypto.createHash("sha1").update(reg.io.readBinary(rel)).digest("hex"));
    } catch { /* skip */ }
  }

  const decisions: SortDecision[] = [];
  const opCtx: OperationContext = {
    sourceSet: new Set(inboxFiles),
    sourceIdsByHandle: {},
    registry: reg,
  };

  for (const unit of units) {
    if ((Date.now() - startTime) / 1000 > SORT_BUDGET_TOTAL) break;

    const ik = `sha1:${crypto.createHash("sha1").update(unit.text).digest("hex").slice(0, 16)}`;
    if (journal.hasIdempotencyKey(ik)) continue;

    const sourcePath = pathFor(unit.handle);
    const [candidates, nearDups] = await scoreCandidates(unit.text, opCtx, unit.handle);
    const filteredCandidates = filterIgnoredCandidates(
      candidates,
      parseIgnorePatterns(settings.ignorePatterns)
    );

    for (const nd of nearDups) {
      const ndPath = pathFor(nd.handle || "");
      decisions.push({
        unitId: unit.id, sourceHandle: unit.handle,
        sourcePath, sourceContent: unit.text,
        action: "near_duplicate", score: nd.score || 0,
        destPath: ndPath, reason: "near-duplicate",
        destHeading: "", destContextBefore: "", destContextAfter: "",
      });
      journal.append(new JournalEntry(
        unit.id, `${ik}-nd`, unit.handle, "flagged",
        nd.handle, undefined, undefined, `near-duplicate: ${(nd.score || 0).toFixed(3)}`,
      ));
    }

    if (filteredCandidates.length === 0) {
      decisions.push({
        unitId: unit.id, sourceHandle: unit.handle,
        sourcePath, sourceContent: unit.text,
        action: "no_destination", reason: "no eligible candidates",
        score: 0, destPath: "", destHeading: "", destContextBefore: "", destContextAfter: "",
      });
      journal.append(new JournalEntry(unit.id, ik, unit.handle, "flagged", undefined, undefined, undefined, "no-eligible-candidates"));
      continue;
    }

    const top = filteredCandidates[0];
    if (top.score >= FALLBACK_CONFIDENCE_FLOOR) {
      const destPath = pathFor(top.handle);
      const destContext = readDestContext(top.handle, top.heading || "");
      decisions.push({
        unitId: unit.id, sourceHandle: unit.handle,
        sourcePath, sourceContent: unit.text,
        action: "placed", score: top.score,
        destPath, destHeading: top.heading || "",
        destContextBefore: destContext.before,
        destContextAfter: destContext.after,
        reason: "",
      });
      journal.append(new JournalEntry(unit.id, ik, unit.handle, "placed", top.handle, top.heading, "r_triage"));
    } else {
      decisions.push({
        unitId: unit.id, sourceHandle: unit.handle,
        sourcePath, sourceContent: unit.text,
        action: "flagged", score: top.score,
        reason: `low-confidence: ${top.score.toFixed(3)}`,
        destPath: "", destHeading: "", destContextBefore: "", destContextAfter: "",
      });
      journal.append(new JournalEntry(unit.id, ik, unit.handle, "flagged", undefined, undefined, undefined, `low-confidence: ${top.score.toFixed(3)}`));
    }
  }

  // Generate suggestions
  let suggestions = "";
  try {
    const sug = await generateSuggestions(journal, manifestConstitution);
    if (sug) suggestions = sug;
  } catch { /* ignore */ }

  // Enforce read-only contract
  for (const [h, beforeHash] of inboxSnapshot) {
    try {
      const p = reg.resolve(h);
      const rel = path.relative(reg.vaultRoot, p);
      const afterHash = crypto.createHash("sha1").update(reg.io.readBinary(rel)).digest("hex");
      if (afterHash !== beforeHash) {
        throw new Error(`Sort authority violation: ${pathFor(h)} was modified during triage.`);
      }
    } catch (e) {
      if (errorMessage(e).includes("authority violation")) throw e;
    }
  }

  journal.clear();

  return new SortResult(decisions, manifestConstitution, suggestions, (Date.now() - startTime) / 1000);
}

// ---------------------------------------------------------------------------
// Orchestrator: chat
// ---------------------------------------------------------------------------

export async function runChat(question: string): Promise<string> {
  const embedder = new Embedder(settings);
  const q = await embedder.embed(question);
  const db = new DatabaseManager(settings.dbPath);
  const results = db.searchSimilar(q, 5);
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

// ---------------------------------------------------------------------------
// Orchestrator: build
// ---------------------------------------------------------------------------

export async function runBuild(vaultPath: string): Promise<string> {
  settings.vaultPath = vaultPath;
  settings.dbPath = path.join(vaultPath, INDEX_DB_SUFFIX);
  toolImpl.resetRegistry();

  const t0 = Date.now();
  const manifestPath = new TocReader(vaultPath).findManifest();
  let manifestGenerated = false;

  if (!manifestPath) {
    console.warn("  [build] No _manifest.md found — building non-manifest index first, then deriving one.");
  }

  const indexer = new Indexer(settings);
  await indexer.build();
  const files = indexer.scanner.scan().length;

  if (!manifestPath) {
    try {
      await generateManifest(vaultPath);
      manifestGenerated = true;
      const indexer2 = new Indexer(settings);
      await indexer2.build();
    } catch (e) {
      console.warn(`  [build] Manifest generation failed (${errorMessage(e)}) — index remains degraded.`);
    }
  }

  const elapsed = (Date.now() - t0) / 1000;

  let msg = `Index built: ${files} files indexed in ${elapsed.toFixed(0)}s at ${settings.dbPath}`;
  if (manifestGenerated) {
    msg = `WARNING: No _manifest.md was found. A manifest was derived from the index and written to the vault — review it before running sort. ${msg}`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

export async function generateManifest(vaultPath: string): Promise<string> {
  const db = new DatabaseManager(settings.dbPath);
  const conn = db.connect();
  const patterns = parseIgnorePatterns(settings.ignorePatterns);

  const rows = conn.prepare<[], { folder: string; path: string }>(
    "SELECT folder, path FROM FILES WHERE folder != '' ORDER BY folder, path"
  ).all();

  const folderFiles = new Map<string, string[]>();
  for (const { folder, path: fpath } of rows) {
    if (pathMatchesPatterns(folder, patterns)) continue;
    const rel = path.relative(folder, fpath);
    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder)!.push(rel);
  }

  if (folderFiles.size === 0) {
    throw new Error("No indexed folders found — cannot derive a manifest.");
  }

  // Syllabus
  const syllabusLines = ["## Vault Tree"];
  const sortedFolders = [...folderFiles.keys()].sort();
  for (const folder of sortedFolders) {
    const depth = folder.split(path.sep).length - 1;
    syllabusLines.push("  ".repeat(depth) + folder + "/");
    for (const f of folderFiles.get(folder)!) {
      syllabusLines.push("  ".repeat(depth + 1) + f);
    }
  }

  for (const folder of sortedFolders) {
    const wikilinks = conn.prepare<[string], { name: string; cnt: number }>(`
      SELECT e.name, COUNT(*) as cnt
      FROM ENTITIES e
      JOIN SECTION_ENTITIES se ON e.entity_id = se.entity_id
      JOIN SECTIONS s ON se.section_key = s.node_key
      JOIN FILES f ON s.file_id = f.file_id
      WHERE f.folder = ? AND e.type = 'wikilink'
      GROUP BY e.name ORDER BY cnt DESC LIMIT 6
    `).all(folder);

    const headings = conn.prepare<[string], { heading_path: string; text: string }>(`
      SELECT s.heading_path, s.text
      FROM SECTIONS s JOIN FILES f ON s.file_id = f.file_id
      WHERE f.folder = ? AND s.heading_path != '' AND s.text != ''
      LIMIT 3
    `).all(folder);

    syllabusLines.push(`\n### ${folder}/`);
    if (wikilinks.length > 0) {
      syllabusLines.push("  Wikilinks: " + wikilinks.slice(0, 5).map((w) => `[[${w.name}]]`).join(", "));
    }
    for (const { heading_path, text } of headings) {
      const snippet = text.slice(0, 100).replace(/\n/g, " ");
      syllabusLines.push(`  - ${heading_path}: ${snippet}...`);
    }
  }
  const syllabus = syllabusLines.join("\n");

  // LLM synthesis
  const scaffoldLines = sortedFolders.map(f => `${f}/ — `);
  const scaffold = scaffoldLines.join("\n");

  const system =
    "Complete each line. The part before ' — ' is a folder path; " +
    "write the folder's PURPOSE after it, in at most 8 words.\n" +
    "Rules:\n- NEVER list file names. NEVER repeat the syllabus.\n" +
    "- Use only information present in the syllabus — no speculation.\n" +
    "- If a folder's content is ambiguous, write '(needs review)'.\n" +
    "Output ONLY the completed lines, one per folder, in the given order.";

  let purposes: Record<string, string> = {};
  try {
    const [response] = await new LLMClient().chat(
      system,
      `Syllabus:\n\n${syllabus}\n\nComplete these lines:\n${scaffold}`,
      null, 1,
    );
    purposes = parseLlmPurposes(response, new Set(sortedFolders));
  } catch (e) {
    console.warn(`  [manifest-gen] LLM synthesis failed (${errorMessage(e)}) — using folder-name hints.`);
  }

  // Render §5.1 manifest
  const lines = ["# vault <!-- Auto-generated from GraphRAG index — review and edit -->"];
  for (const folder of sortedFolders) {
    const folderDepth = folder.split(path.sep).length - 1;
    const parenMatch = folder.match(/\(([^)]+)\)/);
    let purpose: string;
    if (parenMatch) {
      purpose = parenMatch[1].trim();
    } else {
      purpose = purposes[folder] || "(needs review)";
    }
    const indent = "##" + "#".repeat(folderDepth);
    lines.push(`${indent} ${folder}/ <!-- ${purpose} -->`);
    for (const f of folderFiles.get(folder)!) {
      lines.push("     " + f);
    }
    lines.push("");
  }

  const manifestContent = lines.join("\n").trimEnd() + "\n";
  const manifestPath = path.join(vaultPath, settings.manifest.filename);
  new VaultIO(vaultPath).writeTextAtomic(
    settings.manifest.filename.replace(/\\/g, "/"),
    manifestContent,
  );
  return manifestPath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function prependToFile(io: VaultIO, rel: string, prefix: string): void {
  const original = io.readText(rel);
  io.writeTextAtomic(rel, prefix + original);
}

function readDestContext(handle: string, heading: string, contextLines: number = 5): { before: string; after: string } {
  const reg = toolImpl.getRegistry();
  try {
    const content = reg.readFile(handle);
    const rawLines = content.split("\n").map(line => {
      const m = line.match(/^\s*\d+:\s?(.*)/);
      return m ? m[1] : line;
    });

    if (!heading) {
      return {
        before: rawLines.slice(0, 1).join("\n"),
        after: rawLines.slice(1, contextLines + 1).join("\n"),
      };
    }

    const headingLower = heading.toLowerCase().trim();
    let headingIdx = -1;
    for (let i = 0; i < rawLines.length; i++) {
      const stripped = rawLines[i].trim();
      if (stripped.replace(/^#+\s*/, "").toLowerCase() === headingLower ||
          headingLower.includes(stripped.toLowerCase())) {
        headingIdx = i;
        break;
      }
    }

    if (headingIdx < 0) return { before: "", after: "" };

    const start = Math.max(0, headingIdx - contextLines);
    const end = Math.min(rawLines.length, headingIdx + contextLines + 1);
    return {
      before: rawLines.slice(start, headingIdx).join("\n"),
      after: rawLines.slice(headingIdx, end).join("\n"),
    };
  } catch {
    return { before: "", after: "" };
  }
}

function discoverUnits(handles: string[]): Array<{ id: string; handle: string; text: string }> {
  const units: Array<{ id: string; handle: string; text: string }> = [];
  let ctr = 0;
  for (const h of handles) {
    const content = toolImpl.readFile(h);
    if (content.startsWith("READ_ERROR") || content.startsWith("RESOLVE_ERROR")) continue;
    const lines = content.split("\n").map(line => {
      const m = line.match(/^\s*\d+:\s?(.*)/);
      return m ? m[1] : (line.startsWith("---") ? "" : line);
    });
    ctr += 1;
    units.push({ id: `u_${String(ctr).padStart(4, "0")}`, handle: h, text: lines.join("\n") });
  }
  return units;
}

// Candidate produced by scoreCandidates — feeds sort decisions and filters.
interface CandidateInfo {
  handle: string;
  filePath: string;
  heading: string;
  score: number;
  snippet: string;
  contentHash: string;
  fileContentHash: string;
}

async function scoreCandidates(
  text: string,
  opCtx: OperationContext,
  srcHandle: string,
  topK: number = 5,
): Promise<[CandidateInfo[], CandidateInfo[]]> {
  const OVERSCAN = 3;
  const nearDups: CandidateInfo[] = [];
  const eligible: CandidateInfo[] = [];

  try {
    const embedder = new Embedder(settings);
    const q = await embedder.embed(text);
    const db = new DatabaseManager(settings.dbPath);
    const results = db.searchSimilar(q, topK * OVERSCAN);

    for (const r of results) {
      const reg = toolImpl.getRegistry();
      const fp = path.join(reg.vaultRoot, r.filePath);
      let h: string;
      try { h = reg.getHandle(fp); } catch { h = r.filePath; }

      const c: CandidateInfo = {
        handle: h, filePath: r.filePath, heading: r.headingPath,
        score: r.score, snippet: r.text.slice(0, 150),
        contentHash: r.contentHash,
        fileContentHash: r.fileContentHash,
      };

      const d = EligibilityFilter.run(c, opCtx, srcHandle);
      if (d === NEAR_DUP) {
        nearDups.push(c);
      } else if (d === ELIGIBLE) {
        eligible.push(c);
        if (eligible.length >= topK) break;
      }
    }
  } catch { /* ignore */ }

  return [eligible, nearDups];
}

function pathMatchesPatterns(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (isIgnored(relPath, patterns)) return true;
  return patterns.some(p => {
    const dir = p.replace(/\/$/, "");
    if (!dir) return false;
    return normalized === dir || normalized.startsWith(dir + "/");
  });
}

function filterIgnoredCandidates(candidates: CandidateInfo[], patterns: string[]): CandidateInfo[] {
  if (patterns.length === 0) return candidates;
  return candidates.filter(c => !pathMatchesPatterns(c.filePath || "", patterns));
}

function loadManifestConstitution(): string {
  const vaultPath = settings.vaultPath;
  if (!vaultPath) return "";

  try {
    const parser = new ManifestParser(vaultPath);
    const manifestPath = parser.findManifest();
    if (!manifestPath) return "";
    const entries = parser.parse(manifestPath);
    if (entries.length === 0) return "";

    const lines = ["## Vault Manifest — Folder Purposes"];
    for (const entry of entries) {
      appendFolderLines(lines, entry, "");
    }

    const ctd = parser.getContentTypeDefaults(manifestPath);
    if (Object.keys(ctd).length > 0) {
      lines.push("\n## Content Types (inferred from naming)");
      for (const [folder, ctype] of Object.entries(ctd).sort()) {
        lines.push(`- \`${folder}\` → ${ctype}`);
      }
    }
    return lines.join("\n");
  } catch (e) {
    console.warn(`  [manifest] Error loading constitution: ${errorMessage(e)}`);
    return "";
  }
}

function appendFolderLines(lines: string[], entry: ManifestEntry, indent: string): void {
  const purpose = entry.purpose || "(no purpose listed)";
  lines.push(`${indent}- \`${entry.folderPath}\` — ${purpose}`);
  for (const f of entry.files) {
    const suffix = f.comment ? ` — ${f.comment}` : "";
    lines.push(`${indent}    - \`${f.name}\`${suffix}`);
  }
  for (const child of entry.children) {
    appendFolderLines(lines, child, indent + "    ");
  }
}

async function generateSuggestions(journal: Journal, manifestConstitution: string): Promise<string> {
  const entries = journal.allEntries();
  const placed = entries.filter(e => e.state === "placed").length;
  const flagged = entries.filter(e => e.state === "flagged").length;
  const stats = `Placed: ${placed}, Flagged: ${flagged}`;

  const task = `Suggest 2-3 improvements based on this sort:\n${stats}\nList what, why, and risk level.`;
  let system = "You suggest vault organization improvements.";
  if (manifestConstitution) {
    system += `\n\nVault structure:\n${manifestConstitution}`;
  }

  try {
    const [r] = await new LLMClient().chat(system, task, null, 1);
    return r.trim();
  } catch {
    return "";
  }
}

function parseLlmPurposes(response: string, knownFolders: Set<string>): Record<string, string> {
  const purposes: Record<string, string> = {};
  const known = new Map<string, string>();
  const knownLower = new Map<string, string>();
  for (const f of knownFolders) {
    known.set(f.replace(/\/$/, ""), f);
    knownLower.set(f.replace(/\/$/, "").toLowerCase(), f);
  }

  for (const rawLine of response.trim().split("\n")) {
    const line = rawLine.trim().replace(/^[*-]\s*/, "");
    if (!line || !line.includes("—")) continue;
    const [token, ...rest] = line.split("—");
    const purpose = rest.join("—").trim();
    const cleanToken = token.trim().replace(/\/$/, "");
    if (!purpose || purpose.startsWith("[") || purpose.length > 200) continue;

    let folder: string | undefined;
    if (known.has(cleanToken)) {
      folder = known.get(cleanToken);
    } else if (knownLower.has(cleanToken.toLowerCase())) {
      folder = knownLower.get(cleanToken.toLowerCase());
    } else {
      for (const [k, f] of known) {
        if (k.startsWith(cleanToken + " (") || k.startsWith(cleanToken + "/")) {
          folder = f;
          break;
        }
      }
    }
    if (folder) purposes[folder] = purpose;
  }
  return purposes;
}
