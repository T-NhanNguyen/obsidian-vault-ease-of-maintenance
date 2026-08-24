// Sort orchestrator — inbox triage agent flow. Split out of runtime.ts so
// adjusting the sort concern does not touch the cleanup/chat/build
// orchestrators.

import * as crypto from "crypto";
import * as path from "path";
import { settings, INDEX_DB_SUFFIX, thinkingEnabledFor } from "../config";
import { errorMessage } from "../errors";
import { LLMClient } from "./llm";
import * as toolImpl from "./tools";
import { buildComprehendVaultTool } from "./tools_comprehend";
import {
  ELIGIBLE,
  NEAR_DUP,
  EligibilityFilter,
  Journal,
  JournalEntry,
  OperationContext,
  parseIgnorePatterns,
  pathMatchesPatterns,
} from "./engine";
import { Embedder } from "../indexer/embedder";
import { DatabaseManager } from "../indexer/db";
import type { SearchResult } from "../indexer/db";
import { ManifestEntry, ManifestParser } from "../indexer/manifest";
import { readPromptSection, fillTemplate } from "../definitions";
import sortSuggestionsMd from "../../maintainer-definitions/sort-suggestions.md";

const SORT_BUDGET_TOTAL = 240;
const FALLBACK_CONFIDENCE_FLOOR = 0.6;

/** Prompt templates for the post-triage suggestions call — sourced from
 * maintainer-definitions/sort-suggestions.md (tunable without code). */
const SORT_SUGGESTIONS_TEMPLATES = {
  system: readPromptSection(sortSuggestionsMd, "Suggestions system"),
  task: readPromptSection(sortSuggestionsMd, "Suggestions task"),
} as const;

function pathFor(handle: string): string {
  const reg = toolImpl.getRegistry();
  try {
    return path.relative(reg.vaultRoot, reg.resolve(handle));
  } catch {
    return handle;
  }
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
    let results: SearchResult[];
    try {
      results = await db.searchSimilar(q, topK * OVERSCAN);
    } finally {
      await db.close();
    }

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

  const task = fillTemplate(SORT_SUGGESTIONS_TEMPLATES.task, { stats });
  const manifestSection = manifestConstitution ? `\n\nVault structure:\n${manifestConstitution}` : "";
  const system = fillTemplate(SORT_SUGGESTIONS_TEMPLATES.system, { manifest: manifestSection });

  try {
    const [r] = await new LLMClient(undefined, undefined, {
      enableThinking: thinkingEnabledFor("sort"),
    }).chat(system, task, [buildComprehendVaultTool()], 1);
    return r.trim();
  } catch {
    return "";
  }
}
