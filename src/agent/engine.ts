// Engine — deterministic primitives for the agent tooling layer.
// Layer 0: never talks to the model. Pure, testable, deterministic.
// Ported from src/agent/engine.py

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  private entries: Map<string, RegistryEntry> = new Map(); // handle → entry
  private pathToHandle: Map<string, string> = new Map(); // canonical path → handle
  private counter = 0;
  private ignorePatterns: string[];

  constructor(vaultRoot: string, allowedPrefixes: string[] | null = null, ignorePatterns: string[] = []) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.allowedPrefixes = allowedPrefixes;
    this.ignorePatterns = ignorePatterns;
    this.build();
  }

  // ------------------------------------------------------------------
  // Discovery (returns handles)
  // ------------------------------------------------------------------

  listFiles(relPath: string = ""): string {
    const full = this.resolveRelative(relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      return `DIR_NOT_FOUND: ${relPath}`;
    }
    try {
      const lines = [`Contents of /${relPath || ""}:`];
      const names = fs.readdirSync(full).sort();
      for (const name of names) {
        const entryPath = path.join(full, name);
        const isDir = fs.statSync(entryPath).isDirectory();
        const entry = this.register(entryPath, isDir);
        const suffix = isDir ? "/" : "";
        lines.push(`  ${entry.handle}  ${name}${suffix}`);
      }
      return lines.join("\n");
    } catch (e: any) {
      return `LIST_ERROR: ${e.message}`;
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
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      const rel = this.entryFor(filePath).relative;
      const result = [`--- ${handle} (${rel}) ---`];
      for (let i = 0; i < lines.length; i++) {
        result.push(`${String(i + 1).padStart(5)}: ${lines[i]}`);
      }
      return result.join("\n");
    } catch (e: any) {
      return `READ_ERROR: ${e.message}`;
    }
  }

  fileStat(handle: string): FileStat {
    const filePath = this.resolve(handle);
    this.checkScope(filePath);
    const entry = this.entryFor(filePath);
    const content = fs.readFileSync(filePath);
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
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      // Filter hidden dirs and ignored dirs
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith("."));
      const files = entries.filter(e => e.isFile());

      // Check ignore patterns for dirs
      const filteredDirs = dirs.filter(d => {
        const dPath = path.join(dir, d.name);
        const relPath = path.relative(this.vaultRoot, dPath);
        return !isIgnored(relPath, this.ignorePatterns);
      });

      for (const d of filteredDirs) {
        const dPath = path.join(dir, d.name);
        this.register(dPath, true);
      }

      for (const f of files) {
        const fPath = path.join(dir, f.name);
        const relPath = path.relative(this.vaultRoot, fPath);
        if (isIgnored(relPath, this.ignorePatterns)) continue;
        this.register(fPath, false);
      }

      // Recurse into filtered dirs
      for (const d of filteredDirs) {
        walk(path.join(dir, d.name));
      }
    };

    walk(this.vaultRoot);
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
    if (fs.existsSync(canon)) {
      return this.register(canon, fs.statSync(canon).isDirectory());
    }
    throw new Error(`PATH_NOT_IN_REGISTRY: ${filePath}`);
  }

  resolveRelative(relPath: string): string {
    if (!relPath) return this.vaultRoot;
    return path.join(this.vaultRoot, relPath);
  }

  private formatInbox(entry: RegistryEntry): string {
    const lines = [`Inbox folder: ${entry.handle} (${entry.relative})`];
    try {
      const names = fs.readdirSync(entry.path).sort();
      for (const name of names) {
        const fpath = path.join(entry.path, name);
        if (fs.statSync(fpath).isFile() && name.endsWith(".md")) {
          const h = this.register(fpath).handle;
          lines.push(`  ${h}  ${name}`);
        }
      }
    } catch (e: any) {
      lines.push(`  (error reading: ${e.message})`);
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

  static take(filePath: string): Snapshot {
    const content = fs.readFileSync(filePath, "utf-8");
    return new Snapshot(
      filePath,
      content,
      crypto.createHash("sha1").update(content).digest("hex").slice(0, 12),
    );
  }

  restore(): void {
    const dir = path.dirname(this.filePath);
    const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(tmpPath, this.content, "utf-8");
    fs.renameSync(tmpPath, this.filePath);
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
    ops: Array<Record<string, any>>,
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

export interface JournalEntryData {
  unitId: string;
  idempotencyKey: string;
  sourceHandle: string;
  state: string; // pending | placed | flagged
  destinationHandle?: string;
  heading?: string;
  receiptId?: string;
  reason?: string;
}

export class JournalEntry {
  constructor(
    public unitId: string,
    public idempotencyKey: string,
    public sourceHandle: string,
    public state: string,
    public destinationHandle?: string,
    public heading?: string,
    public receiptId?: string,
    public reason?: string,
  ) {}

  toJSON(): string {
    return JSON.stringify({
      unit_id: this.unitId,
      idempotency_key: this.idempotencyKey,
      source_handle: this.sourceHandle,
      state: this.state,
      destination_handle: this.destinationHandle,
      heading: this.heading,
      receipt_id: this.receiptId,
      reason: this.reason,
    });
  }

  static fromJSON(data: Record<string, any>): JournalEntry {
    return new JournalEntry(
      data.unit_id,
      data.idempotency_key,
      data.source_handle,
      data.state,
      data.destination_handle,
      data.heading,
      data.receipt_id,
      data.reason,
    );
  }
}

export class Journal {
  private filePath: string;
  private entries: JournalEntry[] = [];
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(os.tmpdir(), "note-maintainer-sort-journal.jsonl");
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (fs.existsSync(this.filePath)) {
      const lines = fs.readFileSync(this.filePath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.entries.push(JournalEntry.fromJSON(JSON.parse(trimmed)));
        }
      }
    }
  }

  append(entry: JournalEntry): void {
    this.ensureLoaded();
    this.entries.push(entry);
    fs.appendFileSync(this.filePath, entry.toJSON() + "\n");
  }

  hasIdempotencyKey(key: string): boolean {
    this.ensureLoaded();
    return this.entries.some(
      e => e.idempotencyKey === key && (e.state === "placed" || e.state === "flagged")
    );
  }

  pendingUnits(): JournalEntry[] {
    this.ensureLoaded();
    return this.entries.filter(e => e.state === "pending");
  }

  allEntries(): JournalEntry[] {
    this.ensureLoaded();
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.loaded = true;
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt — verifiable proof of work
// ---------------------------------------------------------------------------

export interface ReceiptData {
  receiptId: string;
  handle: string;
  hashBefore: string;
  hashAfter: string;
  opsApplied: number;
  opsRejected: number;
  diffStat: Record<string, number>;
  validation: {
    passed: boolean;
    checks: Record<string, string>;
  };
}

let receiptCounter = 0;

export class Receipt {
  constructor(
    public receiptId: string,
    public handle: string,
    public hashBefore: string,
    public hashAfter: string,
    public opsApplied: number,
    public opsRejected: number,
    public diffStat: Record<string, number>,
    public validation: { passed: boolean; checks: Record<string, string> },
  ) {}

  static create(
    handle: string,
    hashBefore: string,
    hashAfter: string,
    opsApplied: number,
    opsRejected: number,
    diffStat: Record<string, number>,
    validationResults: Record<string, [boolean, string]>,
  ): Receipt {
    receiptCounter += 1;
    const validationPassed = Object.values(validationResults).every(v => v[0]);
    const checks: Record<string, string> = {};
    for (const [k, v] of Object.entries(validationResults)) {
      checks[k] = v[1];
    }
    return new Receipt(
      `r_${String(receiptCounter).padStart(4, "0")}`,
      handle,
      hashBefore,
      hashAfter,
      opsApplied,
      opsRejected,
      diffStat,
      { passed: validationPassed, checks },
    );
  }

  toDict(): ReceiptData {
    return {
      receiptId: this.receiptId,
      handle: this.handle,
      hashBefore: this.hashBefore,
      hashAfter: this.hashAfter,
      opsApplied: this.opsApplied,
      opsRejected: this.opsRejected,
      diffStat: this.diffStat,
      validation: this.validation,
    };
  }
}

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

export type ChunkMeta = Record<string, any>;

export class EligibilityFilter {
  static excludeSelf(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const chunkHandle = chunk.handle || "";
    if (chunkHandle === unitSourceHandle) return EXCLUDED;
    return ELIGIBLE;
  }

  static excludeSourceSet(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const chunkHandle = chunk.handle || "";
    if (ctx.sourceSet.has(chunkHandle)) return EXCLUDED;
    return ELIGIBLE;
  }

  static requireScope(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    if (!ctx.registry) return ELIGIBLE;
    const chunkHandle = chunk.handle || "";
    try {
      ctx.registry.resolve(chunkHandle);
      return ELIGIBLE;
    } catch (e: any) {
      if (e.message?.includes("OUT_OF_SCOPE")) return EXCLUDED;
      return ELIGIBLE;
    }
  }

  static requireFresh(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    if (!ctx.registry) return ELIGIBLE;
    const chunkHandle = chunk.handle || "";
    try {
      const filePath = ctx.registry.resolve(chunkHandle);
      const diskContent = fs.readFileSync(filePath);
      const diskHash = crypto.createHash("sha1").update(diskContent).digest("hex").slice(0, 12);
      const indexHash = (chunk.file_content_hash || "").slice(0, 12);
      if (indexHash && diskHash !== indexHash) return EXCLUDED;
    } catch {
      // Can't check → let through
    }
    return ELIGIBLE;
  }

  static nearDuplicateCheck(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
    const score = chunk.score || 0.0;
    if (score >= NEAR_DUP_TAU) return NEAR_DUP;
    return ELIGIBLE;
  }

  static run(chunk: ChunkMeta, ctx: OperationContext, unitSourceHandle: string): string {
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
  let curr = new Array(n + 1);

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
