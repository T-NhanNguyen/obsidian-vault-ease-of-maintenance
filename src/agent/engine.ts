// Engine — deterministic primitives for the agent tooling layer.
// Layer 0: never talks to the model. Pure, testable, deterministic.
// Ported from src/agent/engine.py

import * as crypto from "crypto";
import * as path from "path";
import { VaultIO } from "../io/vault_io";
import { errorMessage } from "../errors";
import type { EditOp } from "./tools";

// Journal + Receipt subsystem (journal.ts) stays importable from here — the
// journal concern is split out; engine.ts re-exports for import stability.
export { JournalEntry, Journal, Receipt } from "./journal";
export type { JournalEntryData, JournalEntryRow, ReceiptData } from "./journal";

// ---------------------------------------------------------------------------
// Constants — single source of truth
// ---------------------------------------------------------------------------

export const NEAR_DUP_TAU = 0.97;
export const VALID_EDIT_OPS = new Set(["join_lines", "insert_header", "remove_span", "collapse_blanks", "insert_flag"]);
export const VALID_SPAN_KINDS = new Set(["tag", "properties_block"]);
export const ELIGIBLE = "eligible";
export const EXCLUDED = "excluded";
export const NEAR_DUP = "near_duplicate";

// ---------------------------------------------------------------------------
// FileRegistry — handle-based addressing
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  handle: string;
  path: string; // canonical absolute path
  relative: string; // path relative to vault root
  isDir: boolean;
}

export class FileRegistry {
  vaultRoot: string;
  allowedPrefixes: string[] | null;
  readonly io: VaultIO;
  private entries: Map<string, RegistryEntry> = new Map(); // handle → entry
  private pathToHandle: Map<string, string> = new Map(); // canonical path → handle
  private counter = 0;
  private ignorePatterns: string[];

  constructor(vaultRoot: string, allowedPrefixes: string[] | null = null, ignorePatterns: string[] = []) {
    this.io = new VaultIO(vaultRoot);
    // Use the realpath'd root so registry paths and VaultIO guards agree
    // (macOS /var → /private/var, etc.).
    this.vaultRoot = this.io.rootAbs;
    this.allowedPrefixes = allowedPrefixes;
    this.ignorePatterns = ignorePatterns;
    this.build();
  }

  // ------------------------------------------------------------------
  // Discovery (returns handles)
  // ------------------------------------------------------------------

  listFiles(relPath: string = ""): string {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!this.io.isDirectory(rel)) {
      return `DIR_NOT_FOUND: ${relPath}`;
    }
    try {
      const lines = [`Contents of /${relPath || ""}:`];
      const { files, dirs } = this.io.list(rel);
      const names = [...files, ...dirs].sort();
      for (const name of names) {
        const isDir = dirs.includes(name);
        const entryRel = rel ? `${rel}/${name}` : name;
        const entry = this.register(path.join(this.vaultRoot, entryRel), isDir);
        const suffix = isDir ? "/" : "";
        lines.push(`  ${entry.handle}  ${name}${suffix}`);
      }
      return lines.join("\n");
    } catch (e) {
      return `LIST_ERROR: ${errorMessage(e)}`;
    }
  }

  findInbox(): string {
    for (const entry of this.entries.values()) {
      if (entry.isDir && entry.relative.toLowerCase().includes("inbox")) {
        return this.formatInbox(entry);
      }
    }
    return "NO_INBOX_FOUND";
  }

  searchFiles(query: string): string {
    const q = query.toLowerCase();
    const matches: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.isDir && entry.relative.toLowerCase().includes(q)) {
        matches.push(`  ${entry.handle}  ${entry.relative}`);
      }
    }
    if (matches.length === 0) {
      return `NO_FILES_MATCH: ${query}`;
    }
    return "Matching files:\n" + matches.slice(0, 20).join("\n");
  }

  // ------------------------------------------------------------------
  // Resolution (handle → reliable path)
  // ------------------------------------------------------------------

  resolve(handleOrPath: string): string {
    // 1. Exact handle
    const byHandle = this.entries.get(handleOrPath);
    if (byHandle) return byHandle.path;

    // 2. Exact path
    const canon = path.normalize(path.join(this.vaultRoot, handleOrPath));
    if (this.pathToHandle.has(canon)) return canon;

    // 3. Case-insensitive
    const lowerTarget = handleOrPath.toLowerCase();
    for (const entry of this.entries.values()) {
      if (entry.relative.toLowerCase() === lowerTarget) return entry.path;
    }

    // 4. Fuzzy basename match
    const targetBase = path.basename(handleOrPath).toLowerCase();
    const closest: [number, RegistryEntry][] = [];
    for (const entry of this.entries.values()) {
      const eb = path.basename(entry.relative).toLowerCase();
      const dist = editDistance(targetBase, eb);
      if (dist < 5) closest.push([dist, entry]);
    }
    closest.sort((a, b) => a[0] - b[0]);

    if (closest.length > 0) {
      const best = closest[0][1];
      throw new Error(
        `UNKNOWN_FILE: No file matches '${handleOrPath}'. ` +
        `Closest: '${best.handle}' → '${best.relative}'. Use the handle.`
      );
    }

    throw new Error(
      `UNKNOWN_FILE: '${handleOrPath}' not found in vault. ` +
      `Use listFiles() to discover available handles.`
    );
  }

  getHandle(filePath: string): string {
    const canon = path.resolve(filePath);
    const h = this.pathToHandle.get(canon);
    if (h) return h;
    throw new Error(`PATH_NOT_REGISTERED: ${filePath}`);
  }

  readFile(handle: string): string {
    const filePath = this.resolve(handle);
    this.checkScope(filePath);
    try {
      const rel = path.relative(this.vaultRoot, filePath);
      const lines = this.io.readText(rel).split("\n");
      const relLabel = this.entryFor(filePath).relative;
      const result = [`--- ${handle} (${relLabel}) ---`];
      for (let i = 0; i < lines.length; i++) {
        result.push(`${String(i + 1).padStart(5)}: ${lines[i]}`);
      }
      return result.join("\n");
    } catch (e) {
      return `READ_ERROR: ${errorMessage(e)}`;
    }
  }

  fileStat(handle: string): FileStat {
    const filePath = this.resolve(handle);
    this.checkScope(filePath);
    const entry = this.entryFor(filePath);
    const rel = path.relative(this.vaultRoot, filePath);
    const content = this.io.readBinary(rel);
    return {
      handle: entry.handle,
      relative: entry.relative,
      path: entry.path,
      size: content.length,
      hash: crypto.createHash("sha1").update(content).digest("hex").slice(0, 12),
      lineCount: content.filter(b => b === 0x0a).length + 1,
    };
  }

  // ------------------------------------------------------------------
  // Scope / jail
  // ------------------------------------------------------------------

  private checkScope(filePath: string): void {
    const canon = path.resolve(filePath);
    if (!canon.startsWith(this.vaultRoot + path.sep) && canon !== this.vaultRoot) {
      throw new Error(`OUT_OF_SCOPE: ${filePath} is outside vault root`);
    }
    if (this.allowedPrefixes !== null) {
      const rel = path.relative(this.vaultRoot, canon);
      const allowed = this.allowedPrefixes.some(p => rel.startsWith(p));
      if (!allowed) {
        throw new Error(`OUT_OF_SCOPE: handle for '${rel}' is not in your granted scope`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private build(): void {
    const walk = (relDir: string): void => {
      const { files, dirs } = this.io.list(relDir);

      // Filter hidden dirs and ignored dirs
      const filteredDirs = dirs.filter(d => {
        if (d.startsWith(".")) return false;
        const rel = relDir ? `${relDir}/${d}` : d;
        return !isIgnored(rel, this.ignorePatterns);
      });

      for (const d of filteredDirs) {
        this.register(path.join(this.vaultRoot, relDir ? `${relDir}/${d}` : d), true);
      }

      for (const f of files) {
        const rel = relDir ? `${relDir}/${f}` : f;
        if (isIgnored(rel, this.ignorePatterns)) continue;
        this.register(path.join(this.vaultRoot, rel), false);
      }

      // Recurse into filtered dirs
      for (const d of filteredDirs) {
        walk(relDir ? `${relDir}/${d}` : d);
      }
    };

    walk("");
  }

  register(filePath: string, isDir: boolean = false): RegistryEntry {
    const canon = path.resolve(filePath);
    const existing = this.pathToHandle.get(canon);
    if (existing) return this.entries.get(existing)!;

    this.counter += 1;
    const handle = `f_${String(this.counter).padStart(4, "0")}`;
    const rel = path.relative(this.vaultRoot, canon);
    const entry: RegistryEntry = { handle, path: canon, relative: rel, isDir };
    this.entries.set(handle, entry);
    this.pathToHandle.set(canon, handle);
    return entry;
  }

  private entryFor(filePath: string): RegistryEntry {
    const canon = path.resolve(filePath);
    const h = this.pathToHandle.get(canon);
    if (h) return this.entries.get(h)!;
    // Lazily register if it exists on disk
    const rel = path.relative(this.vaultRoot, canon);
    if (rel !== "" && !rel.startsWith("..") && this.io.exists(rel)) {
      return this.register(canon, this.io.isDirectory(rel));
    }
    throw new Error(`PATH_NOT_IN_REGISTRY: ${filePath}`);
  }

  private formatInbox(entry: RegistryEntry): string {
    const lines = [`Inbox folder: ${entry.handle} (${entry.relative})`];
    try {
      const { files } = this.io.list(entry.relative);
      for (const name of files.sort()) {
        if (name.endsWith(".md")) {
          const rel = entry.relative ? `${entry.relative}/${name}` : name;
          const h = this.register(path.join(this.vaultRoot, rel)).handle;
          lines.push(`  ${h}  ${name}`);
        }
      }
    } catch (e) {
      lines.push(`  (error reading: ${errorMessage(e)})`);
    }
    return lines.join("\n");
  }
}

export interface FileStat {
  handle: string;
  relative: string;
  path: string;
  size: number;
  hash: string;
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Snapshot — point-in-time file state for rollback
// ---------------------------------------------------------------------------

export class Snapshot {
  constructor(
    public filePath: string,
    public content: string,
    public hash: string,
  ) {}

  static take(filePath: string, io: VaultIO): Snapshot {
    const rel = path.relative(io.rootAbs, filePath);
    const content = io.readText(rel);
    return new Snapshot(
      filePath,
      content,
      crypto.createHash("sha1").update(content).digest("hex").slice(0, 12),
    );
  }

  restore(io: VaultIO): void {
    const rel = path.relative(io.rootAbs, this.filePath);
    io.writeTextAtomic(rel, this.content);
  }
}

// ---------------------------------------------------------------------------
// Validators — mechanical checks computable without an LLM
// ---------------------------------------------------------------------------

const PROTECTED_PATTERNS: [RegExp, string][] = [
  [/```[\s\S]*?```/g, "code_fence"],
  [/`[^`\n]+`/g, "inline_code"],
  [/!\[\[[^\]]+\]\]/g, "image_embed"],
  [/\[\[[^\]]+\]\]/g, "wikilink"],
  [/https?:\/\/[^\s()<>"']+/g, "url"],
  [/^|.+\|.+\|/gm, "table_row"],
];

export function extractProtectedSpans(text: string): Record<string, string[]> {
  const spans: Record<string, string[]> = {};
  for (const [pattern, kind] of PROTECTED_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      spans[kind] = matches;
    }
  }
  return spans;
}

export function tokenizeWords(text: string): string[] {
  const cleaned = text.replace(/[^\w\s]/g, " ");
  return cleaned.split(/\s+/).map(w => w.toLowerCase()).filter(w => w.length > 0);
}

export class Validators {
  static wordConservation(
    before: string,
    after: string,
    sanctionedRemovals: string[] | null = null,
  ): [boolean, string] {
    const beforeWords = new Set(tokenizeWords(before));
    const afterWords = new Set(tokenizeWords(after));
    let missing = new Set([...beforeWords].filter(w => !afterWords.has(w)));
    if (sanctionedRemovals) {
      const sanctioned = new Set(tokenizeWords(sanctionedRemovals.join(" ")));
      missing = new Set([...missing].filter(w => !sanctioned.has(w)));
    }
    if (missing.size > 0) {
      return [false, `CONTENT_LOST: ${[...missing].join(", ")}`];
    }
    return [true, "word_conservation: pass"];
  }

  static headersPreserved(before: string, after: string): [boolean, string] {
    const hb = [...before.matchAll(/^(#+ .+)$/gm)].map(m => m[1]);
    const ha = [...after.matchAll(/^(#+ .+)$/gm)].map(m => m[1]);
    let haIdx = 0;
    for (const h of hb) {
      let found = false;
      while (haIdx < ha.length) {
        if (ha[haIdx] === h) {
          found = true;
          haIdx++;
          break;
        }
        haIdx++;
      }
      if (!found) return [false, `HEADER_MISSING: ${h}`];
    }
    return [true, "headers_preserved: pass"];
  }

  static protectedSpansIntact(before: string, after: string): [boolean, string] {
    for (const [pattern, kind] of PROTECTED_PATTERNS) {
      const beforeSet = new Set(before.match(pattern) || []);
      const afterSet = new Set(after.match(pattern) || []);
      const missing = [...beforeSet].filter(x => !afterSet.has(x));
      if (missing.length > 0) {
        return [false, `PROTECTED_SPAN_LOST (${kind}): ${missing.slice(0, 3).join(", ")}`];
      }
    }
    return [true, "protected_spans: pass"];
  }

  static joinPunctuation(
    ops: EditOp[],
    afterLines: string[],
  ): [boolean, string] {
    for (const op of ops) {
      if (op.op === "join_lines") {
        const s = (op.anchor?.start || 0) - 1;
        const e = (op.anchor?.end || 0) - 1;
        const joined = afterLines.slice(s, e + 1).map((l: string) => l.trim()).join(" ");
        if (!joined.trimEnd().endsWith(".")) {
          return [false, `JOIN_MISSING_PERIOD at lines ${s + 1}-${e + 1}`];
        }
      }
    }
    return [true, "join_punctuation: pass"];
  }
}

// ---------------------------------------------------------------------------
// Journal — append-only progress ledger
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ExclusionFilter — ignore patterns from the plugin Settings tab
// ---------------------------------------------------------------------------

export function parseIgnorePatterns(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

export function isIgnored(relPath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = relPath.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  for (let pattern of patterns) {
    const negate = pattern.startsWith("!");
    const p = pattern.replace(/^!/, "");
    if (fnmatch(normalized, p) || fnmatch(basename, p)) {
      if (!negate) return true;
    }
  }
  return false;
}

// Simple glob matching (fnmatch equivalent)
function fnmatch(name: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${reStr}$`).test(name);
}

/** True when the path is ignored or sits under an ignored directory. */
export function pathMatchesPatterns(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (isIgnored(relPath, patterns)) return true;
  return patterns.some(p => {
    const dir = p.replace(/\/$/, "");
    if (!dir) return false;
    return normalized === dir || normalized.startsWith(dir + "/");
  });
}

// ---------------------------------------------------------------------------
// OperationContext — dynamic state for a single sort invocation
// ---------------------------------------------------------------------------

export interface OperationContext {
  sourceSet: Set<string>;
  sourceIdsByHandle: Record<string, string>;
  registry: FileRegistry | null;
}

// ---------------------------------------------------------------------------
// EligibilityFilter — composable filter chain for placement candidates
// ---------------------------------------------------------------------------

export interface ChunkMeta {
  handle?: string;
  score?: number;
  file_content_hash?: string;
}

export class EligibilityFilter {
  static excludeSelf(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const chunkHandle = chunk.handle || "";
    if (chunkHandle === unitSourceHandle) return EXCLUDED;
    return ELIGIBLE;
  }

  static excludeSourceSet(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const chunkHandle = chunk.handle || "";
    if (ctx.sourceSet.has(chunkHandle)) return EXCLUDED;
    return ELIGIBLE;
  }

  static requireScope(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    if (!ctx.registry) return ELIGIBLE;
    const chunkHandle = chunk.handle || "";
    try {
      ctx.registry.resolve(chunkHandle);
      return ELIGIBLE;
    } catch (e) {
      if (errorMessage(e).includes("OUT_OF_SCOPE")) return EXCLUDED;
      return ELIGIBLE;
    }
  }

  static requireFresh(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    if (!ctx.registry) return ELIGIBLE;
    const chunkHandle = chunk.handle || "";
    try {
      const filePath = ctx.registry.resolve(chunkHandle);
      const rel = path.relative(ctx.registry.vaultRoot, filePath);
      const diskContent = ctx.registry.io.readBinary(rel);
      const diskHash = crypto.createHash("sha1").update(diskContent).digest("hex").slice(0, 12);
      const indexHash = (chunk.file_content_hash || "").slice(0, 12);
      if (indexHash && diskHash !== indexHash) return EXCLUDED;
    } catch {
      // Can't check → let through
    }
    return ELIGIBLE;
  }

  static nearDuplicateCheck(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const score = chunk.score || 0.0;
    if (score >= NEAR_DUP_TAU) return NEAR_DUP;
    return ELIGIBLE;
  }

  static run(this: void, chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    for (const filterFn of [
      EligibilityFilter.nearDuplicateCheck,
      EligibilityFilter.excludeSelf,
      EligibilityFilter.excludeSourceSet,
      EligibilityFilter.requireScope,
      EligibilityFilter.requireFresh,
    ]) {
      const result = filterFn(chunk, ctx, unitSourceHandle);
      if (result !== ELIGIBLE) return result;
    }
    return ELIGIBLE;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const editDistanceCache = new Map<string, number>();

export function editDistance(a: string, b: string): number {
  const key = `${a}|${b}`;
  const cached = editDistanceCache.get(key);
  if (cached !== undefined) return cached;

  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  editDistanceCache.set(key, prev[n]);
  return prev[n];
}
