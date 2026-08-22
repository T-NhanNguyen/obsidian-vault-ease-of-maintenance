// Batch Skim — the vault-comprehension sampler (GraphChat design, milestone 1).
//
// Reads the vault like flipping through pages: one deterministic pass emits a
// single terse JSON report for the whole vault (or a filtered subtree) —
// frontmatter, heading outline, word count, and a first-N-words excerpt per
// note, plus one summary line per top-level folder.
//
//   - Root notes and MOC notes  → full first-N-words excerpt (their own caps).
//   - Remaining notes           → stratified sample across top-level folders
//                                 (largest-remainder proportional allocation,
//                                 deterministic even-stride picks) sharing the
//                                 token budget with an adaptive per-file cap.
//   - Every directory           → one summary line (file count, avg length,
//                                 dominant tags), sampled or not.
//   - Optional mtime cache      → re-runs only re-derive changed files.
//
// Token discipline: words are the token proxy (whitespace-delimited,
// deterministic, dependency-free). All sample sizes and budgets are word
// counts. Output is JSON only — the human-readable flag lives on the ledger
// print (testing), not here.

import * as path from "path";
import { VaultIO } from "../io/vault_io";
import { pathMatchesPatterns } from "../agent/engine";

/** Bump to invalidate all cached entries (schema change). */
export const SKIM_CACHE_VERSION = 1;

/** Max heading-outline lines emitted per note (outlines past this are
 * truncated — token discipline; wordCount still reflects the full note). */
export const OUTLINE_CAP = 30;

export interface SkimOptions {
  /** Total excerpt budget (words) shared by the sampled regular notes. */
  tokenBudget: number;
  /** Full excerpt for root notes (README etc.). */
  rootExcerptWords: number;
  /** Full excerpt for MOC notes. */
  mocExcerptWords: number;
  /** Per-file cap for regular notes (adaptive: budget / sample count). */
  regularExcerptWords: number;
  /** Target sample size across all regular notes (proportional per folder). */
  sampleTargetFiles: number;
  /** Ignore patterns from the plugin settings (parseIgnorePatterns). */
  ignorePatterns: string[];
}

export type SkimNoteKind = "root" | "moc" | "regular";

export interface SkimFileEntry {
  path: string;
  kind: SkimNoteKind;
  title: string;
  /** False for regular notes the stratified sample did not pick — their
   * excerpt is empty and outline/frontmatter are omitted (token discipline;
   * the directory summary carries their aggregate). */
  sampled: boolean;
  frontmatter: Record<string, unknown> | null;
  outline: string[];
  wordCount: number;
  excerpt: string;
}

export interface SkimDirectorySummary {
  /** "" for the vault root. */
  path: string;
  fileCount: number;
  avgWords: number;
  dominantTags: { tag: string; count: number }[];
}

export interface SkimParameters {
  tokenBudget: number;
  rootExcerptWords: number;
  mocExcerptWords: number;
  regularExcerptWords: number;
  sampleTargetFiles: number;
  /** Effective adaptive per-file budget used this run. */
  perFileBudget: number;
  sampledRegularCount: number;
}

export interface SkimReport {
  sampledAt: string;
  parameters: SkimParameters;
  directories: SkimDirectorySummary[];
  notes: SkimFileEntry[];
  totalWords: number;
  cacheHits: number;
}

export interface SkimParams {
  vaultPath: string;
  options: SkimOptions;
  /** Optional subtree filter (deepen pass): keep only paths containing this
   * substring (case-insensitive). */
  pathFilter?: string;
  /** Optional mtime cache path (vault-relative). Absent → no caching. */
  cachePath?: string;
}

// ---------------------------------------------------------------------------
// Word counting
// ---------------------------------------------------------------------------

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function firstWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return words.join(" ");
  return words.slice(0, n).join(" ");
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Minimal frontmatter parser: `---` block, flat keys, scalar values
 * (quoted strings, numbers, booleans), inline `[a, b]` lists, and indented
 * `- item` lists. Unknown/odd shapes degrade to strings — never throw. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return { frontmatter: null, body: content };
  const block = match[1];
  const body = content.slice(match[0].length);
  if (!block.trim()) return { frontmatter: {}, body };
  return { frontmatter: parseFrontmatterBlock(block), body };
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const rawLine of block.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0 && trimmed.includes(":")) {
      const colon = trimmed.indexOf(":");
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (value === "") {
        currentKey = key;
        result[key] = [];
      } else {
        currentKey = null;
        result[key] = parseScalarValue(value);
      }
    } else if (indent > 0 && currentKey && trimmed.startsWith("- ")) {
      const list = result[currentKey];
      if (Array.isArray(list)) {
        list.push(parseScalarValue(trimmed.slice(2).trim()));
      }
    }
  }
  return result;
}

function parseScalarValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => parseScalarValue(s.trim()))
      .filter((s) => s !== "");
  }
  return value;
}

export function extractTags(frontmatter: Record<string, unknown> | null): string[] {
  if (!frontmatter) return [];
  const tags = frontmatter["tags"];
  if (Array.isArray(tags)) return tags.map((t) => String(t)).filter(Boolean);
  if (typeof tags === "string") {
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Note classification
// ---------------------------------------------------------------------------

export function headingOutline(body: string): string[] {
  const outline: string[] = [];
  for (const line of body.split("\n")) {
    if (outline.length >= OUTLINE_CAP) break;
    if (/^#{1,6}\s+/.test(line)) outline.push(line.trim());
  }
  return outline;
}

/** MOC note: filename contains "moc" (case-insensitive), frontmatter
 * `type: MOC`, or a `#MOC` tag. */
export function isMocNote(
  title: string,
  frontmatter: Record<string, unknown> | null,
  tags: string[],
): boolean {
  if (title.toLowerCase().includes("moc")) return true;
  const type = frontmatter?.["type"];
  if (typeof type === "string" && type.toLowerCase() === "moc") return true;
  return tags.some((t) => t.toLowerCase() === "moc");
}

export function classifyNote(
  relPath: string,
  title: string,
  frontmatter: Record<string, unknown> | null,
  tags: string[],
): SkimNoteKind {
  if (isMocNote(title, frontmatter, tags)) return "moc";
  if (!relPath.includes("/")) return "root";
  return "regular";
}

function topLevelFolder(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Sampling math (deterministic — no RNG, stable tiebreaks)
// ---------------------------------------------------------------------------

/** Largest-remainder proportional allocation: each stratum's target is
 * proportional to its share of the files, floors first, then the remainder
 * goes to the largest fractional parts (tiebreak: name ascending). */
function allocateSampleTargets(
  strata: { name: string; size: number }[],
  totalFiles: number,
  target: number,
): Map<string, number> {
  const targets = new Map<string, number>();
  if (totalFiles === 0 || target <= 0) return targets;

  const withFractions = strata.map((s) => {
    const exact = (s.size / totalFiles) * target;
    const floor = Math.floor(exact);
    return { name: s.name, size: s.size, floor, frac: exact - floor };
  });

  let remainder = Math.max(0, target - withFractions.reduce((acc, e) => acc + e.floor, 0));
  const byFraction = [...withFractions].sort(
    (a, b) => b.frac - a.frac || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const e of byFraction) {
    if (remainder <= 0) break;
    if (e.floor + 1 <= e.size) {
      e.floor += 1;
      remainder -= 1;
    }
  }
  for (const e of withFractions) {
    targets.set(e.name, Math.min(e.size, e.floor));
  }
  return targets;
}

/** Deterministic even-stride picks over the sorted path list. target <=
 * files.length here (enforced by allocateSampleTargets' cap). */
function sampleFiles(files: string[], target: number): string[] {
  if (target >= files.length) return files;
  const picked: string[] = [];
  for (let k = 0; k < target; k++) {
    const idx = Math.min(files.length - 1, Math.round((k * files.length) / target));
    const file = files[idx];
    if (!picked.includes(file)) picked.push(file);
  }
  return picked;
}

function perFileBudget(regularCount: number, tokenBudget: number, cap: number): number {
  if (regularCount === 0) return 0;
  return Math.max(1, Math.min(cap, Math.floor(tokenBudget / regularCount)));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface SkimCacheEntryFile {
  mtimeMs: number;
  /** Derived metadata WITHOUT the excerpt, plus the body prefix (first words
   * up to the largest cap) so the report can re-slice excerpts without
   * re-reading the file. */
  meta: Omit<SkimFileEntry, "excerpt">;
  bodyPrefix: string;
}

interface SkimCacheFile {
  version: number;
  entries: Record<string, SkimCacheEntryFile>;
}

class SkimCache {
  hits = 0;
  private data: SkimCacheFile = { version: SKIM_CACHE_VERSION, entries: {} };
  private loaded = false;

  constructor(private io: VaultIO, private cachePath: string | null) {}

  private ensureLoaded(): void {
    if (this.loaded || !this.cachePath) return;
    this.loaded = true;
    if (!this.io.exists(this.cachePath)) return;
    try {
      const parsed = JSON.parse(this.io.readText(this.cachePath)) as SkimCacheFile;
      if (parsed.version === SKIM_CACHE_VERSION && parsed.entries) {
        this.data = parsed;
      }
    } catch {
      // Corrupt / partial cache — start clean, never crash the skim.
    }
  }

  get(filePath: string, mtimeMs: number): SkimCacheEntryFile | null {
    this.ensureLoaded();
    const hit = this.data.entries[filePath];
    if (hit && hit.mtimeMs === mtimeMs) {
      this.hits += 1;
      return hit;
    }
    return null;
  }

  put(filePath: string, mtimeMs: number, cached: SkimCacheEntryFile): void {
    this.ensureLoaded();
    this.data.entries[filePath] = cached;
  }

  save(): void {
    if (!this.cachePath) return;
    this.io.writeTextAtomic(this.cachePath, JSON.stringify(this.data));
  }
}

// ---------------------------------------------------------------------------
// Scan + derive
// ---------------------------------------------------------------------------

interface ScannedFile {
  path: string;
  title: string;
  mtimeMs: number;
}

function scanFiles(io: VaultIO, ignorePatterns: string[]): ScannedFile[] {
  const files: ScannedFile[] = [];
  const walk = (relDir: string): void => {
    const { files: fileNames, dirs: dirNames } = io.list(relDir);
    const dirs = dirNames.filter((name) => {
      if (name.startsWith(".")) return false;
      const rel = relDir ? `${relDir}/${name}` : name;
      // pathMatchesPatterns (not isIgnored) — it also rejects paths sitting
      // under an ignored directory (pattern "drafts/" blocks "drafts/x.md").
      return !pathMatchesPatterns(rel, ignorePatterns);
    });
    for (const name of fileNames) {
      if (!name.endsWith(".md")) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (pathMatchesPatterns(relPath, ignorePatterns)) continue;
      const stat = io.stat(relPath);
      if (!stat) continue;
      files.push({ path: relPath, title: path.basename(name, ".md"), mtimeMs: stat.mtimeMs });
    }
    for (const d of dirs) {
      walk(relDir ? `${relDir}/${d}` : d);
    }
  };
  walk("");
  return files;
}

// ---------------------------------------------------------------------------
// Directory summaries
// ---------------------------------------------------------------------------

function buildDirectorySummaries(
  files: { path: string; frontmatter: Record<string, unknown> | null; wordCount: number }[],
): SkimDirectorySummary[] {
  const byFolder = new Map<string, typeof files>();
  for (const entry of files) {
    const folder = topLevelFolder(entry.path);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(entry);
  }
  const summaries: SkimDirectorySummary[] = [];
  for (const [folder, folderFiles] of [...byFolder.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const totalWords = folderFiles.reduce((acc, f) => acc + f.wordCount, 0);
    const avgWords = folderFiles.length > 0 ? Math.round(totalWords / folderFiles.length) : 0;
    const tagCounts = new Map<string, number>();
    for (const f of folderFiles) {
      for (const tag of extractTags(f.frontmatter)) {
        const key = tag.toLowerCase();
        tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
      }
    }
    const dominantTags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
      .slice(0, 3);
    summaries.push({ path: folder, fileCount: folderFiles.length, avgWords, dominantTags });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

export function sampleVault(params: SkimParams): SkimReport {
  const io = new VaultIO(params.vaultPath);
  const cache = new SkimCache(io, params.cachePath ?? null);
  const filter = params.pathFilter ? params.pathFilter.toLowerCase() : null;
  const maxCap = Math.max(
    params.options.rootExcerptWords,
    params.options.mocExcerptWords,
    params.options.regularExcerptWords,
  );

  if (!io.isDirectory("")) {
    return {
      sampledAt: new Date().toISOString(),
      parameters: emptyParameters(params.options),
      directories: [],
      notes: [],
      totalWords: 0,
      cacheHits: 0,
    };
  }

  const scanned = scanFiles(io, params.options.ignorePatterns)
    .filter((f) => !filter || f.path.toLowerCase().includes(filter))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Derive (cache-aware) metadata for every scanned file.
  const metas = new Map<string, Omit<SkimFileEntry, "excerpt"> & { bodyPrefix: string }>();
  for (const f of scanned) {
    const cached = cache.get(f.path, f.mtimeMs);
    if (cached) {
      metas.set(f.path, { ...cached.meta, bodyPrefix: cached.bodyPrefix });
      continue;
    }
    const content = io.readText(f.path);
    const { frontmatter, body } = parseFrontmatter(content);
    const tags = extractTags(frontmatter);
    const kind = classifyNote(f.path, f.title, frontmatter, tags);
    const meta = {
      path: f.path,
      kind,
      title: f.title,
      sampled: false,
      frontmatter,
      outline: headingOutline(body),
      wordCount: countWords(body),
      bodyPrefix: firstWords(body, maxCap),
    };
    metas.set(f.path, meta);
    cache.put(f.path, f.mtimeMs, {
      mtimeMs: f.mtimeMs,
      meta: {
        path: meta.path,
        kind: meta.kind,
        title: meta.title,
        sampled: meta.sampled,
        frontmatter: meta.frontmatter,
        outline: meta.outline,
        wordCount: meta.wordCount,
      },
      bodyPrefix: meta.bodyPrefix,
    });
  }
  cache.save();

  // Full-excerpt tier: root + MOC notes (all included).
  const fullTier = [...metas.values()].filter(
    (m) => m.kind === "root" || m.kind === "moc",
  );
  // Stratified tier: regular notes sampled proportionally per top-level folder.
  const regularMetas = [...metas.values()].filter((m) => m.kind === "regular");
  const strata = new Map<string, typeof regularMetas>();
  for (const m of regularMetas) {
    const folder = topLevelFolder(m.path);
    if (!strata.has(folder)) strata.set(folder, []);
    strata.get(folder)!.push(m);
  }
  const targets = allocateSampleTargets(
    [...strata.entries()].map(([name, files]) => ({ name, size: files.length })),
    regularMetas.length,
    params.options.sampleTargetFiles,
  );
  const sampledSet = new Set<string>();
  for (const [name, files] of [...strata.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const target = targets.get(name) ?? 0;
    const paths = files.map((m) => m.path).sort();
    for (const picked of sampleFiles(paths, target)) {
      sampledSet.add(picked);
    }
  }

  const perFile = perFileBudget(
    sampledSet.size,
    params.options.tokenBudget,
    params.options.regularExcerptWords,
  );

  // Assemble report notes (deterministic path order) and slice excerpts.
  // R2.1: unsampled regular notes are dropped from the report entirely —
  // their metadata still feeds the directory summaries below.
  const notes: SkimFileEntry[] = [];
  let totalWords = 0;
  for (const meta of metas.values()) {
    const sampled = fullTier.includes(meta) || sampledSet.has(meta.path);
    if (meta.kind === "regular" && !sampled) continue;
    const budget =
      meta.kind === "root"
        ? params.options.rootExcerptWords
        : meta.kind === "moc"
          ? params.options.mocExcerptWords
          : perFile;
    const excerpt = firstWords(meta.bodyPrefix, budget);
    totalWords += countWords(excerpt);
    notes.push({
      path: meta.path,
      kind: meta.kind,
      title: meta.title,
      sampled,
      frontmatter: sampled ? meta.frontmatter : null,
      outline: sampled ? meta.outline : [],
      wordCount: meta.wordCount,
      excerpt,
    });
  }

  // All files (sampled or not) feed the directory summaries — full metadata,
  // so unsampled notes still contribute tags and lengths.
  const allFiles = [...metas.values()].map((m) => ({
    path: m.path,
    frontmatter: m.frontmatter,
    wordCount: m.wordCount,
  }));

  return {
    sampledAt: new Date().toISOString(),
    parameters: {
      tokenBudget: params.options.tokenBudget,
      rootExcerptWords: params.options.rootExcerptWords,
      mocExcerptWords: params.options.mocExcerptWords,
      regularExcerptWords: params.options.regularExcerptWords,
      sampleTargetFiles: params.options.sampleTargetFiles,
      perFileBudget: perFile,
      sampledRegularCount: sampledSet.size,
    },
    directories: buildDirectorySummaries(allFiles),
    notes,
    totalWords,
    cacheHits: cache.hits,
  };
}

function emptyParameters(options: SkimOptions): SkimParameters {
  return {
    tokenBudget: options.tokenBudget,
    rootExcerptWords: options.rootExcerptWords,
    mocExcerptWords: options.mocExcerptWords,
    regularExcerptWords: options.regularExcerptWords,
    sampleTargetFiles: options.sampleTargetFiles,
    perFileBudget: 0,
    sampledRegularCount: 0,
  };
}
