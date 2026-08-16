// Community reports + global query mode (Phase 4 of the GraphRAG buildout,
// see .dev-vault/handoff.md).
//
// The two things that make this GraphRAG and not a vector index:
//   1. Build-side per-community LLM summaries (COMMUNITY_REPORTS) — derived
//      data, regenerable, stored separately from assignment so a rebuild can
//      overwrite it without touching COMMUNITY_SECTIONS.
//   2. globalQuery — the canonical "global mode": embed the question, rank
//      the reports by cosine, and let one LLM synthesis call answer from the
//      top reports. Exposed as the chat entry for overview questions; when
//      reports are absent (offline build, LLM failure) it degrades to local
//      mode with a clear message — never hangs, never crashes.
//
// The module is PURE at the core (estimateTokens / buildReportContext /
// isOverviewQuestion are hand-computable and deterministic); the async
// drivers (generateCommunityReports / globalQuery) take a ReportLlm seam so
// tests assert the INPUTS (which sections reached the prompt, the context
// cap, the ranked reports) with a fake LLM — never the real network.

import { settings, resolveApiKey, thinkingEnabledFor } from "../config";
import { errorMessage } from "../errors";
import { getLlmClient, detectProvider } from "../agent/llm_client";
import type { ILlmClient } from "../agent/llm_client";
import { cosineSimilarity } from "./embedding";
import { significantTokens } from "./graph_search";
import type { IEmbedder } from "./embedder";
import type {
  CommunityReportRow,
  CommunityReportWriteInput,
  CommunityRow,
  SectionSearchRow,
} from "./db_worker/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough token estimate divisor — the standard chars/4 rule of thumb. */
const CHARS_PER_TOKEN = 4;

/**
 * Accumulated member-section token budget per community report. Sections are
 * included in node_key order; once the budget is full the remaining sections
 * are DROPPED (the report never sees a partial, unreadable tail).
 */
export const DEFAULT_REPORT_CONTEXT_CAP_TOKENS = 3000;

/** How many top-ranked reports the global synthesis call is grounded in. */
export const DEFAULT_TOP_REPORTS = 3;

/** Question markers that signal "overview of the vault" (global mode). */
export const OVERVIEW_MARKERS = ["overview", "summar", "topic", "structure", "contents"] as const;

export const REPORT_SYSTEM_PROMPT =
  "You are a librarian summarizing one group of related notes (a community) in a personal notes vault.\n" +
  "The sections below are all members of the same community. Write a concise markdown report:\n" +
  "- One short summary paragraph: what this community is about and how its topics relate.\n" +
  "- A bullet list of the key topics or concepts, one line each.\n" +
  "Rules:\n- Use ONLY the provided sections — never invent facts.\n" +
  "- Keep the report under 150 words.\n" +
  "- Output ONLY the markdown report.";

export const GLOBAL_SYSTEM_PROMPT =
  "You are a research assistant for a personal notes vault. The user asked an overview question about the vault as a whole.\n" +
  "You are given summaries of the vault's most relevant communities, each under a '## <community>' heading.\n" +
  "Answer the question using ONLY those summaries — never invent facts, never mention notes or sections the summaries do not cover.\n" +
  "Write in short markdown: brief paragraphs and **bold** for key terms. If the summaries do not answer the question, say so plainly.";

const NO_REPORTS_MESSAGE =
  "No community reports exist — global mode is unavailable. The index may have been " +
  "built without an LLM pass, or the last build's report generation failed.";

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** Rough token count for a text — chars / 4, ceil (hand-computable). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A context block selected for one community report. */
export interface ReportContext {
  /** The markdown block passed to the LLM ("### heading\ntext" per section). */
  context: string;
  /** Member section node_keys included, in node_key order. */
  includedSectionKeys: string[];
  /** Total estimated tokens of the included section texts. */
  totalTokens: number;
}

/**
 * Select member sections for a report under the token budget. Deterministic:
 * sections are sorted by node_key (never input order); each fits if the
 * accumulated estimate stays within the cap, otherwise the REST are dropped.
 * Sections with empty text are skipped.
 */
export function buildReportContext(
  sections: SectionSearchRow[],
  capTokens: number = DEFAULT_REPORT_CONTEXT_CAP_TOKENS,
): ReportContext {
  const ordered = [...sections].sort((a, b) => a.node_key.localeCompare(b.node_key));
  const blocks: string[] = [];
  const includedSectionKeys: string[] = [];
  let totalTokens = 0;

  for (const section of ordered) {
    const text = (section.text || "").trim();
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (tokens === 0) continue;
    if (totalTokens + tokens > capTokens) break; // cap enforced — drop beyond
    blocks.push(`### ${section.heading_path || section.node_key}\n${text}`);
    includedSectionKeys.push(section.node_key);
    totalTokens += tokens;
  }

  return { context: blocks.join("\n\n"), includedSectionKeys, totalTokens };
}

/**
 * Overview questions route to global mode: pure-stopword questions ("what is
 * this vault about?") have no retrieval tokens, so every significant token
 * either comes back empty or a known overview marker appears.
 */
export function isOverviewQuestion(question: string): boolean {
  if (significantTokens(question).length === 0) return true;
  const lower = question.toLowerCase();
  return OVERVIEW_MARKERS.some((marker) => lower.includes(marker));
}

// ---------------------------------------------------------------------------
// LLM seam
// ---------------------------------------------------------------------------

/** One completion's observable surface for report generation / synthesis. */
export interface ReportLlmResult {
  content: string;
  totalTokens: number;
  model: string;
}

/** The LLM surface both drivers need — faked in tests (StubLlmClient style). */
export interface ReportLlm {
  complete(system: string, user: string): Promise<ReportLlmResult>;
}

/**
 * Default ReportLlm — one provider chat completion (the generateManifest
 * pattern: a single chat call, no tools). The optional llm param is a test
 * seam only; enableThinking honors the build feature gate like
 * generateManifest does.
 */
export class ChatReportLlm implements ReportLlm {
  private readonly client: ILlmClient;
  private readonly model: string;

  constructor(options: { model?: string; llm?: ILlmClient; enableThinking?: boolean } = {}) {
    this.model = options.model || settings.agent.model;
    const enableThinking = options.enableThinking ?? thinkingEnabledFor("build");
    this.client = options.llm || getLlmClient(
      detectProvider(settings.api.baseUrl || ""),
      this.model,
      resolveApiKey(),
      settings.api.baseUrl,
      enableThinking,
    );
  }

  async complete(system: string, user: string): Promise<ReportLlmResult> {
    const response = await this.client.chatCompletion(this.model, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    return {
      content: response.content || "",
      totalTokens: response.usage?.totalTokens ?? 0,
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Report generation (build side)
// ---------------------------------------------------------------------------

/** The DB surface report generation needs — DatabaseManager satisfies this. */
export interface CommunityReportStore {
  getAllCommunities(): Promise<CommunityRow[]>;
  getSectionsForCommunity(communityId: string): Promise<SectionSearchRow[]>;
  upsertCommunityReport(report: CommunityReportWriteInput): Promise<void>;
}

/** One community's written report plus the sections that fed it. */
export interface CommunityReportResult {
  communityId: string;
  report: string;
  model: string;
  tokens: number;
  includedSectionKeys: string[];
}

/**
 * Build-side report generation: one LLM call per community (in
 * community_id order — deterministic) over the member sections under the
 * context cap; the markdown report is stored in COMMUNITY_REPORTS with the
 * model + token usage. Communities with no section content are skipped
 * (report stays absent). An LLM failure propagates — the caller (build)
 * catches it and warns; already-written reports remain.
 */
export async function generateCommunityReports(
  db: CommunityReportStore,
  llm: ReportLlm,
  opts: { contextCapTokens?: number } = {},
): Promise<CommunityReportResult[]> {
  const capTokens = opts.contextCapTokens ?? DEFAULT_REPORT_CONTEXT_CAP_TOKENS;
  const communities = await db.getAllCommunities();
  const results: CommunityReportResult[] = [];

  for (const community of communities) {
    const sections = await db.getSectionsForCommunity(community.community_id);
    const built = buildReportContext(sections, capTokens);
    if (built.includedSectionKeys.length === 0) continue;

    const label = community.label || community.community_id;
    const completion = await llm.complete(
      REPORT_SYSTEM_PROMPT,
      `Community: ${label}\n\nSections:\n${built.context}`,
    );
    await db.upsertCommunityReport({
      communityId: community.community_id,
      report: completion.content,
      model: completion.model,
      tokens: completion.totalTokens,
    });
    results.push({
      communityId: community.community_id,
      report: completion.content,
      model: completion.model,
      tokens: completion.totalTokens,
      includedSectionKeys: built.includedSectionKeys,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Global query mode (the differentiator)
// ---------------------------------------------------------------------------

/** The DB surface global mode needs — DatabaseManager satisfies this. */
export interface GlobalQueryDb {
  getAllCommunityReports(): Promise<CommunityReportRow[]>;
  getAllCommunities(): Promise<CommunityRow[]>;
}

export interface GlobalQueryOptions {
  /** How many top-ranked reports feed the synthesis (default 3). */
  topReports?: number;
}

/** One selected report with its community label (for the UI / context). */
export interface SelectedReport {
  communityId: string;
  label: string;
}

export interface GlobalQueryResult {
  /** "global" when answered from reports; "local" when degraded. */
  mode: "global" | "local";
  /** The synthesized answer (empty when degraded). */
  answer: string;
  /** The reports the synthesis was grounded in (empty when degraded). */
  selectedReports: SelectedReport[];
  /** Why global mode was unavailable / failed (degraded paths only). */
  message?: string;
}

/**
 * Canonical global mode: embed the question, rank the stored reports by
 * cosine, and synthesize an answer from the top reports. Every degraded path
 * returns mode "local" with a clear message and NO LLM call — reports absent
 * (offline build), ranking failure (no embedder key), or synthesis failure.
 */
export async function globalQuery(
  embedder: IEmbedder,
  db: GlobalQueryDb,
  llm: ReportLlm,
  question: string,
  opts: GlobalQueryOptions = {},
): Promise<GlobalQueryResult> {
  const topReports = opts.topReports ?? DEFAULT_TOP_REPORTS;

  const rows = (await db.getAllCommunityReports()).filter(
    (row) => row.report && row.report.trim().length > 0,
  );
  if (rows.length === 0) {
    return { mode: "local", answer: "", selectedReports: [], message: NO_REPORTS_MESSAGE };
  }

  const communities = await db.getAllCommunities();
  const labelById = new Map(communities.map((c) => [c.community_id, c.label || c.community_id]));

  let selected: Array<{ row: CommunityReportRow; label: string }> = [];
  try {
    const queryEmbedding = await embedder.embed(question);
    const reportEmbeddings = await embedder.embedBatch(rows.map((r) => r.report || ""));
    selected = rows
      .map((row, i) => ({
        row,
        label: labelById.get(row.community_id) || row.community_id,
        score: cosineSimilarity(queryEmbedding, reportEmbeddings[i] || []),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.row.community_id < b.row.community_id ? -1 : a.row.community_id > b.row.community_id ? 1 : 0),
      )
      .slice(0, topReports);
  } catch (e) {
    return {
      mode: "local",
      answer: "",
      selectedReports: [],
      message: `Global retrieval failed (${errorMessage(e)}) — falling back to local mode.`,
    };
  }

  const selectedReports: SelectedReport[] = selected.map((s) => ({
    communityId: s.row.community_id,
    label: s.label,
  }));
  const context = selected.map((s) => `## ${s.label}\n${s.row.report}`).join("\n\n");

  try {
    const completion = await llm.complete(
      GLOBAL_SYSTEM_PROMPT,
      `Community summaries:\n\n${context}\n\nQuestion: ${question}`,
    );
    const answer = completion.content.trim() || "[The agent produced no answer text.]";
    return { mode: "global", answer, selectedReports };
  } catch (e) {
    return {
      mode: "local",
      answer: "",
      selectedReports,
      message: `Global synthesis failed (${errorMessage(e)}) — falling back to local mode.`,
    };
  }
}
