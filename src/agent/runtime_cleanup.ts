// Cleanup orchestrator — clean-current-note agent flow. Split out of
// runtime.ts so adjusting the cleanup concern does not touch the sort/chat/
// build orchestrators.

import * as crypto from "crypto";
import * as path from "path";
import { settings, INDEX_DB_SUFFIX } from "../config";
import { VaultIO } from "../io/vault_io";
import { LLMClient, Tool } from "./llm";
import * as toolImpl from "./tools";
import { tokenizeWords, Validators } from "./engine";
import type { ChatMessage } from "./llm_client";
import cleanupSkillMd from "../../maintainer-definitions/phase-1-note-cleanup.md";

const CLEANUP_SKILL_FILENAME = "phase-1-note-cleanup.md";
const REWRITE_CONTENT_THRESHOLD = 0.2;

function loadSkill(skillName: string): string {
  // Skills are bundled at build time via esbuild's text loader (.md → text).
  // Runtime disk reads are unreliable inside Obsidian (no __dirname), so the
  // skill content ships inside main.js — no pathing to go wrong.
  if (skillName === CLEANUP_SKILL_FILENAME) return cleanupSkillMd;
  return `# ${skillName}\n\n(Skill file not found)`;
}

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

function prependToFile(io: VaultIO, rel: string, prefix: string): void {
  const original = io.readText(rel);
  io.writeTextAtomic(rel, prefix + original);
}
