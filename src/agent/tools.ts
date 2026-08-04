// Tool implementations for the agent runtime.
// Ported from src/agent/tools.py

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { settings } from "../config";
import {
  FileRegistry,
  Receipt,
  Snapshot,
  Validators,
  parseIgnorePatterns,
} from "./engine";
import { Embedder } from "../indexer/embedder";
import { DatabaseManager } from "../indexer/db";
import { INDEX_DB_SUFFIX } from "../config";

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
  } catch (e: any) {
    return `STAT_ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

export async function searchIndex(query: string, topK: number = 5): Promise<string> {
  try {
    const embedder = new Embedder(settings);
    const queryEmb = await embedder.embed(query);
    const db = new DatabaseManager(settings.dbPath);
    const results = db.searchSimilar(queryEmb, topK);
    if (results.length === 0) return "NO_RESULTS";

    const reg = getRegistry();
    const lines: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let handle: string;
      try {
        handle = reg.getHandle(path.join(reg.vaultRoot, r.filePath));
      } catch {
        handle = r.filePath;
      }
      lines.push(
        `[${i + 1}] ${handle} heading=${r.headingPath} score=${r.score.toFixed(3)}\n    ${r.text.slice(0, 200)}`
      );
    }
    return lines.join("\n");
  } catch (e: any) {
    return `SEARCH_ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// apply_edits — the ONLY mutation tool
// ---------------------------------------------------------------------------

function validateOp(op: Record<string, any>, lines: string[]): string | null {
  const kind = op.op;
  const anchor = op.anchor || {};
  const maxLine = lines.length;

  if (!["join_lines", "insert_header", "remove_span", "collapse_blanks", "insert_flag"].includes(kind)) {
    return `UNKNOWN_OP: ${kind}`;
  }

  for (const key of ["start", "end", "before_line"]) {
    const val = anchor[key];
    if (val !== undefined && (typeof val !== "number" || val < 1 || val > maxLine + 10)) {
      return `INVALID_ANCHOR: ${key}=${val} (max_line=${maxLine})`;
    }
  }

  const s = anchor.start;
  const e = anchor.end;
  if (s !== undefined && e !== undefined && s > e) {
    return `INVALID_RANGE: start=${s} > end=${e}`;
  }

  if (kind === "remove_span") {
    const validKinds = ["tag", "properties_block"];
    if (!validKinds.includes(op.kind)) {
      return `INVALID_KIND: ${op.kind} (expected ${validKinds.join(", ")})`;
    }
  }

  return null;
}

export function applyEdits(handle: string, ops: Array<Record<string, any>>): string {
  const reg = getRegistry();
  let filePath: string;
  try {
    filePath = reg.resolve(handle);
  } catch (e: any) {
    return `RESOLVE_ERROR: ${e.message}`;
  }

  // Snapshot before
  const before = Snapshot.take(filePath);
  let lines = before.content.split("\n");

  // Validate ops before applying
  const rejected: Array<{ op: string; reason: string }> = [];
  const validOps: Array<Record<string, any>> = [];

  for (const op of ops) {
    const err = validateOp(op, lines);
    if (err) {
      rejected.push({ op: op.op, reason: err });
    } else {
      validOps.push(op);
    }
  }

  if (rejected.length > 0 && validOps.length === 0) {
    return JSON.stringify({
      error: "ALL_OPS_REJECTED",
      rejected,
      file_unchanged: true,
    });
  }

  // Apply valid ops in order
  let offset = 0;
  const diffStat: Record<string, number> = {};

  for (const op of validOps) {
    const kind = op.op;
    diffStat[kind] = (diffStat[kind] || 0) + 1;
    const anchor = op.anchor;

    if (kind === "join_lines") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      lines[s] = lines.slice(s, e + 1).map((l: string) => l.trim()).join(" ");
      lines.splice(s + 1, e - s);
      offset -= e - s;
    } else if (kind === "insert_header") {
      const idx = anchor.before_line - 1 + offset;
      lines.splice(idx, 0, op.text);
      offset += 1;
    } else if (kind === "remove_span") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      lines.splice(s, e - s + 1);
      offset -= e - s + 1;
    } else if (kind === "collapse_blanks") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      const blankCount = lines.slice(s, Math.min(e + 1, lines.length))
        .filter((l: string) => !l.trim()).length;
      if (blankCount > 1) {
        let keptOne = false;
        const newLines = lines.slice(0, s);
        for (let i = s; i < Math.min(e + 1, lines.length); i++) {
          if (!lines[i].trim()) {
            if (!keptOne) {
              newLines.push("");
              keptOne = true;
            }
          } else {
            newLines.push(lines[i]);
          }
        }
        if (e + 1 < lines.length) {
          newLines.push(...lines.slice(e + 1));
        }
        lines = newLines;
      }
    } else if (kind === "insert_flag") {
      const idx = anchor.before_line - 1 + offset;
      const flag = `<!-- review: ${op.reason || "flag"} -->`;
      lines.splice(idx, 0, flag);
      offset += 1;
    }
  }

  // Write result atomically
  const result = lines.join("\n");
  const tmpPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmpPath, result, "utf-8");
  fs.renameSync(tmpPath, filePath);

  // Snapshot after
  const after = Snapshot.take(filePath);

  // Run validators
  const sanctionWords: string[] = [];
  for (const op of ops) {
    if (op.op === "remove_span" && ["tag", "properties_block"].includes(op.kind)) {
      sanctionWords.push(op.kind);
    }
  }

  const validationResults: Record<string, [boolean, string]> = {
    word_conservation: Validators.wordConservation(before.content, result, sanctionWords),
    headers_preserved: Validators.headersPreserved(before.content, result),
    protected_spans: Validators.protectedSpansIntact(before.content, result),
    join_punctuation: Validators.joinPunctuation(validOps, lines),
  };

  const receipt = Receipt.create(
    handle,
    before.hash,
    after.hash,
    validOps.length,
    rejected.length,
    diffStat,
    validationResults,
  );

  // Store result text
  lastPreviewResult = result;

  return JSON.stringify(receipt.toDict(), null, 2);
}

// ---------------------------------------------------------------------------
// apply_edits_impl — compute receipt without writing to disk
// ---------------------------------------------------------------------------

export function applyEditsImpl(handle: string, ops: Array<Record<string, any>>): string {
  const reg = getRegistry();
  let filePath: string;
  try {
    filePath = reg.resolve(handle);
  } catch (e: any) {
    return `RESOLVE_ERROR: ${e.message}`;
  }

  const before = Snapshot.take(filePath);
  let lines = before.content.split("\n");

  const rejected: Array<{ op: string; reason: string }> = [];
  const validOps: Array<Record<string, any>> = [];

  for (const op of ops) {
    const err = validateOp(op, lines);
    if (err) {
      rejected.push({ op: op.op, reason: err });
    } else {
      validOps.push(op);
    }
  }

  if (rejected.length > 0 && validOps.length === 0) {
    lastPreviewResult = before.content;
    return JSON.stringify({
      error: "ALL_OPS_REJECTED",
      rejected,
      file_unchanged: true,
    });
  }

  let offset = 0;
  const diffStat: Record<string, number> = {};

  for (const op of validOps) {
    const kind = op.op;
    diffStat[kind] = (diffStat[kind] || 0) + 1;
    const anchor = op.anchor;

    if (kind === "join_lines") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      lines[s] = lines.slice(s, e + 1).map((l: string) => l.trim()).join(" ");
      lines.splice(s + 1, e - s);
      offset -= e - s;
    } else if (kind === "insert_header") {
      const idx = anchor.before_line - 1 + offset;
      lines.splice(idx, 0, op.text);
      offset += 1;
    } else if (kind === "remove_span") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      lines.splice(s, e - s + 1);
      offset -= e - s + 1;
    } else if (kind === "collapse_blanks") {
      const s = anchor.start - 1 + offset;
      const e = anchor.end - 1 + offset;
      const blankCount = lines.slice(s, Math.min(e + 1, lines.length))
        .filter((l: string) => !l.trim()).length;
      if (blankCount > 1) {
        let keptOne = false;
        const newLines = lines.slice(0, s);
        for (let i = s; i < Math.min(e + 1, lines.length); i++) {
          if (!lines[i].trim()) {
            if (!keptOne) {
              newLines.push("");
              keptOne = true;
            }
          } else {
            newLines.push(lines[i]);
          }
        }
        if (e + 1 < lines.length) {
          newLines.push(...lines.slice(e + 1));
        }
        lines = newLines;
      }
    } else if (kind === "insert_flag") {
      const idx = anchor.before_line - 1 + offset;
      const flag = `<!-- review: ${op.reason || "flag"} -->`;
      lines.splice(idx, 0, flag);
      offset += 1;
    }
  }

  const result = lines.join("\n");
  const afterHash = crypto.createHash("sha1").update(result).digest("hex").slice(0, 12);

  const sanctionWords: string[] = [];
  for (const op of ops) {
    if (op.op === "remove_span" && ["tag", "properties_block"].includes(op.kind)) {
      sanctionWords.push(op.kind);
    }
  }

  const validationResults: Record<string, [boolean, string]> = {
    word_conservation: Validators.wordConservation(before.content, result, sanctionWords),
    headers_preserved: Validators.headersPreserved(before.content, result),
    protected_spans: Validators.protectedSpansIntact(before.content, result),
    join_punctuation: Validators.joinPunctuation(validOps, lines),
  };

  const receipt = Receipt.create(
    handle,
    before.hash,
    afterHash,
    validOps.length,
    rejected.length,
    diffStat,
    validationResults,
  );

  lastPreviewResult = result;

  return JSON.stringify(receipt.toDict(), null, 2);
}

// ---------------------------------------------------------------------------
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
