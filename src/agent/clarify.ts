// Portable clarification dialog for the vault manifest (handoff Part A).
// The dialog module is shared: sort and build-index call it; it imports no
// sort code or build code. The caller decides when to start the dialog and
// what to do with the result.
//
// Flow: read the manifest from disk (fresh or user-edited — never a cached
// copy) → compare it with the vault folders → run a bounded Q&A dialog (one
// self-contained question per uncovered folder, asked through the caller's
// ask channel) → prepare apply_edits ops that insert
// `## folder/ <!-- purpose -->` entries at the correct heading depth → return
// the proposed content, the ops, and a diff.
//
// The module never writes. Only the confirmed write (writeClarifyProposal,
// called by the caller after the user accepts) touches disk, and it guards
// the round trip through the parser before writing.

import { VaultIO } from "../io/vault_io";
import { pathMatchesPatterns } from "./engine";
import { applyOps, type EditOp } from "./tools_apply_edits";
import { TocReader, TOC_HEADER, type ManifestEntry } from "../indexer/manifest";

export const MANIFEST_H1 = "# vault <!-- Auto-generated from GraphRAG index — review and edit -->";
const FOLDER_FILE_SAMPLE = 6;
const MAX_PURPOSE_CHARS = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultFolderInfo {
  /** Vault-relative folder path (no trailing slash). */
  path: string;
  /** Direct markdown file names inside the folder (basenames, sorted). */
  files: string[];
}

export interface ClarifyQuestion {
  folderPath: string;
  /** One clear question the user can answer in a few words. */
  prompt: string;
  /** The context the user needs to answer — the question stays self-contained. */
  context?: string;
  /** Optional closed answer choices. */
  options?: string[];
}

export interface ClarifyAnswer {
  question: ClarifyQuestion;
  answer: string;
}

/** Returns the answer verbatim, or null when the user did not answer
 * (deadline hit / dialog aborted). */
export type AskQuestion = (question: ClarifyQuestion) => Promise<string | null>;

/** Builds the question to ask for an uncovered folder. Return null to skip
 * the folder (left unanswered). The deterministic default is
 * buildFolderQuestion; consumers (chat, future harness users) inject their
 * own source — e.g. questions derived by a reasoning model from the
 * evidence the task produced. */
export type QuestionSource = (folder: VaultFolderInfo) => ClarifyQuestion | null;

export interface ClarifyDialogInput {
  vaultPath: string;
  /** Vault-relative manifest path, or null when no manifest exists yet. */
  manifestPath: string | null;
  /** The vault folder scan (hidden + ignored folders already excluded). */
  folders: VaultFolderInfo[];
  ask: AskQuestion;
  /** Question source for the uncovered folders — defaults to the
   * deterministic buildFolderQuestion (the no-tool-call path). */
  questionSource?: QuestionSource;
  /** Epoch ms. The dialog stops asking once passed (optional — interactive
   * callers leave it unset and rely on the ask channel's null answer). */
  deadlineMs?: number;
}

export interface ClarifyProposal {
  manifestPath: string | null;
  /** Original manifest content ("" when no manifest exists). */
  before: string;
  /** Proposed manifest content. */
  after: string;
  /** apply_edits ops that turn before into after (all insert_header ops). */
  ops: EditOp[];
  /** The Q&A turns that produced purposes. */
  answered: ClarifyAnswer[];
  /** Folders with no entry proposed (skipped, deadline hit, or empty answer). */
  unanswered: string[];
  /** Unified-diff text (before → after) for the review surface. */
  diff: string;
}

/** One recorded clarification exchange — the free-form question text and the
 * user's answer (the shape the conversation store keeps per turn). */
export interface ClarifyTurnRecord {
  question: string;
  answer: string;
}

/** The manifest state a dialog run starts from: the discovered manifest, its
 * on-disk content, and the folders it does not cover. */
export interface ManifestContext {
  manifestPath: string | null;
  before: string;
  uncovered: VaultFolderInfo[];
}

/** The full review-surface contract the clarify command uses: ask questions,
 * review the proposal, and surface status text. */
export interface ClarifyDialogChannel {
  ask(question: ClarifyQuestion): Promise<string | null>;
  showProposal(proposal: ClarifyProposal): Promise<"accept" | "reject">;
  notify(text: string): void;
}

// ---------------------------------------------------------------------------
// Vault scan — folders with their direct markdown files
// ---------------------------------------------------------------------------

export function scanVaultFolders(vaultPath: string, ignorePatterns: string[]): VaultFolderInfo[] {
  const io = new VaultIO(vaultPath);
  const folders: VaultFolderInfo[] = [];

  const walk = (relDir: string): void => {
    const { files, dirs } = io.list(relDir);
    if (relDir) {
      folders.push({
        path: relDir,
        files: files.filter(name => name.endsWith(".md")).sort(),
      });
    }
    const subdirs = dirs
      .filter(name => !name.startsWith("."))
      .filter(name => {
        const rel = relDir ? `${relDir}/${name}` : name;
        return !pathMatchesPatterns(rel, ignorePatterns);
      })
      .sort();
    for (const name of subdirs) {
      walk(relDir ? `${relDir}/${name}` : name);
    }
  };

  walk("");
  return folders.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Uncovered-folder detection
// ---------------------------------------------------------------------------

function resolveEntryPath(parentPrefix: string, folderPath: string): string {
  if (!parentPrefix) return folderPath;
  if (folderPath.startsWith(parentPrefix + "/")) return folderPath;
  return `${parentPrefix}/${folderPath}`;
}

/** Folder paths the manifest covers — the bare name AND the parent-prefixed
 * path are collected, so hand-written (bare child names) and generated
 * (full-path children) manifests both match the disk scan. */
function coveredFolderPaths(entries: ManifestEntry[]): Set<string> {
  const covered = new Set<string>();
  const walk = (entry: ManifestEntry, parentPrefix: string): void => {
    const full = resolveEntryPath(parentPrefix, entry.folderPath);
    covered.add(entry.folderPath);
    covered.add(full);
    for (const child of entry.children) walk(child, full);
  };
  for (const entry of entries) walk(entry, "");
  return covered;
}

export function computeUncoveredFolders(
  manifestEntries: ManifestEntry[],
  folders: VaultFolderInfo[],
): VaultFolderInfo[] {
  const covered = coveredFolderPaths(manifestEntries);
  return folders.filter(folder => !covered.has(folder.path));
}

/** Discovers the manifest on disk (TocReader's recursive search) and reads
 * its content + uncovered folders — the state a dialog run starts from.
 * Callers that already know the manifest path read it directly instead. */
export function computeManifestContext(
  vaultPath: string,
  folders: VaultFolderInfo[],
): ManifestContext {
  const manifestPath = new TocReader(vaultPath).findManifest();
  const io = new VaultIO(vaultPath);
  const before = manifestPath && io.exists(manifestPath)
    ? io.readText(manifestPath)
    : "";
  const entries = new TocReader(vaultPath)._parseContent(before);
  return { manifestPath, before, uncovered: computeUncoveredFolders(entries, folders) };
}

// ---------------------------------------------------------------------------
// Question building — one self-contained question per folder
// ---------------------------------------------------------------------------

export function buildFolderQuestion(folder: VaultFolderInfo): ClarifyQuestion {
  const sample = folder.files.slice(0, FOLDER_FILE_SAMPLE).join(", ");
  const filesLine = folder.files.length
    ? ` Files: ${sample}${folder.files.length > FOLDER_FILE_SAMPLE ? ", …" : ""}.`
    : "";
  return {
    folderPath: folder.path,
    prompt: `What is the purpose of the folder "${folder.path}"? Answer in a few words — this becomes the manifest purpose line.`,
    context:
      `The manifest (_manifest.md) lists each vault folder with a one-line purpose: ` +
      `\`## folder/ <!-- purpose -->\`.${filesLine}`,
  };
}

function sanitizePurpose(answer: string): string {
  return answer
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PURPOSE_CHARS);
}

// ---------------------------------------------------------------------------
// Dialog runner — read, detect, ask (bounded), propose
// ---------------------------------------------------------------------------

const compareFolders = (a: VaultFolderInfo, b: VaultFolderInfo): number =>
  a.path.localeCompare(b.path);

const compareAnswers = (a: ClarifyAnswer, b: ClarifyAnswer): number =>
  compareFolders({ path: a.question.folderPath, files: [] }, { path: b.question.folderPath, files: [] });

/** Runs the dialog. Returns null when there is nothing to propose (all
 * folders covered, or no answer produced a purpose). */
export async function runClarifyDialog(input: ClarifyDialogInput): Promise<ClarifyProposal | null> {
  const io = new VaultIO(input.vaultPath);
  const before = input.manifestPath && io.exists(input.manifestPath)
    ? io.readText(input.manifestPath)
    : "";
  const entries = new TocReader(input.vaultPath)._parseContent(before);
  const uncovered = computeUncoveredFolders(entries, input.folders);
  if (uncovered.length === 0) return null;

  const answered: ClarifyAnswer[] = [];
  const unanswered: string[] = [];
  let deadlineHit = false;
  for (const folder of [...uncovered].sort(compareFolders)) {
    if (deadlineHit) {
      unanswered.push(folder.path);
      continue;
    }
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      deadlineHit = true;
      unanswered.push(folder.path);
      continue;
    }
    const question = (input.questionSource ?? buildFolderQuestion)(folder);
    if (!question) {
      unanswered.push(folder.path);
      continue;
    }
    const answer = await input.ask(question);
    if (answer == null) {
      deadlineHit = true;
      unanswered.push(folder.path);
      continue;
    }
    const purpose = sanitizePurpose(answer);
    if (purpose) {
      answered.push({ question, answer: purpose });
    } else {
      unanswered.push(folder.path);
    }
  }

  return proposeManifestEdit(input.manifestPath, before, answered, unanswered);
}

/** The propose phase shared by the ask-driven dialog and the replay path
 * (buildProposalFromTurns): build the apply_edits ops, apply them, render
 * the diff, and normalize the trailing newline (POSIX convention, the same
 * generateManifest uses — no 1-byte churn on regeneration). */
function proposeManifestEdit(
  manifestPath: string | null,
  before: string,
  answered: ClarifyAnswer[],
  unanswered: string[],
): ClarifyProposal | null {
  if (answered.length === 0) return null;

  const ops = buildManifestOps(before, answered);
  const applied = applyOps(ops, before ? before.split("\n") : []);
  const joined = applied.lines.join("\n");
  const after = joined === "" ? "" : joined.endsWith("\n") ? joined : `${joined}\n`;

  return {
    manifestPath,
    before,
    after,
    ops,
    answered,
    unanswered,
    diff: lineDiff(before, after),
  };
}

/** Reconciles free-form Q&A turns (the model's clarify calls recorded in the
 * conversation store) back into a manifest proposal WITHOUT re-asking: each
 * turn is matched to the uncovered folder its question mentions (longest
 * path contained in the text, then unambiguous basename), sanitized, and
 * proposed through the same ops → diff pipeline as the ask-driven dialog.
 * When a folder has several turns, the LAST answer wins — the model's
 * propose-and-confirm pattern asks once for the raw purpose and again to
 * confirm the refined wording; the confirmed line is what gets written.
 * Unmatched turns stay out of the proposal (they are conversation memory
 * only). Returns null when no turn matched an uncovered folder. */
export function buildProposalFromTurns(input: {
  vaultPath: string;
  folders: VaultFolderInfo[];
  turns: ClarifyTurnRecord[];
}): ClarifyProposal | null {
  const context = computeManifestContext(input.vaultPath, input.folders);
  const matched = new Map<string, ClarifyTurnRecord>(); // folderPath → last turn
  for (const turn of input.turns) {
    const folderPath = matchFolderInQuestion(turn.question, context.uncovered);
    if (folderPath) matched.set(folderPath, turn);
  }
  if (matched.size === 0) return null;

  const answered: ClarifyAnswer[] = [];
  for (const [folderPath, turn] of matched) {
    const purpose = sanitizePurpose(turn.answer);
    if (purpose) {
      answered.push({ question: { folderPath, prompt: turn.question }, answer: purpose });
    }
  }
  const unanswered = context.uncovered
    .filter(folder => !matched.has(folder.path))
    .map(folder => folder.path);
  return proposeManifestEdit(context.manifestPath, context.before, answered, unanswered);
}

/** The folder an (unstructured) question mentions: the longest uncovered
 * path contained verbatim in the question, else the folder whose basename
 * appears and is unambiguous among the uncovered set. */
function matchFolderInQuestion(question: string, uncovered: VaultFolderInfo[]): string | null {
  const candidates = [...uncovered].sort((a, b) => b.path.length - a.path.length);
  for (const folder of candidates) {
    if (question.includes(folder.path)) return folder.path;
  }
  const basenamePaths = new Map<string, string[]>();
  for (const folder of candidates) {
    const basename = folder.path.split("/").pop()!;
    if (!basenamePaths.has(basename)) basenamePaths.set(basename, []);
    basenamePaths.get(basename)!.push(folder.path);
  }
  for (const folder of candidates) {
    const basename = folder.path.split("/").pop()!;
    if (basenamePaths.get(basename)!.length === 1 && question.includes(basename)) {
      return folder.path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest edit planning — apply_edits ops at the correct heading depth
// ---------------------------------------------------------------------------

interface EntryAnchor {
  folderPath: string;
  level: number;
  blockEndIdx: number;
}

/** Existing manifest entries as line spans (block = header + files + children). */
function computeEntryAnchors(lines: string[]): EntryAnchor[] {
  const anchors: EntryAnchor[] = [];
  const stack: EntryAnchor[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = TOC_HEADER.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    if (level === 1) continue; // H1 = vault root marker, not an entry
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const closed = stack.pop()!;
      closed.blockEndIdx = i - 1;
      anchors.push(closed);
    }
    stack.push({ folderPath: m[2].trim().replace(/\/$/, ""), level, blockEndIdx: -1 });
  }
  while (stack.length > 0) {
    const closed = stack.pop()!;
    closed.blockEndIdx = lines.length - 1;
    anchors.push(closed);
  }
  return anchors;
}

interface PlannedInsertion {
  beforeLine: number;
  text: string;
  folderPath: string;
}

/** Insertion plan: every new entry inherits the before_line of its deepest
 * anchor (an existing manifest entry's block end, or an already-placed new
 * ancestor). Planned ops are emitted in (before_line, path) order — parent
 * lines land before their children at the same anchor, and ops at different
 * anchors cannot interleave with existing content when applyOps shifts
 * lines. */
function planInsertions(lines: string[], answered: ClarifyAnswer[]): PlannedInsertion[] {
  const anchors = new Map<string, EntryAnchor>();
  for (const anchor of computeEntryAnchors(lines)) anchors.set(anchor.folderPath, anchor);

  const h1Idx = lines.findIndex(line => /^#{1}\s/.test(line));
  const needsH1 = h1Idx < 0;
  const baseBeforeLine = needsH1 ? 1 : h1Idx + 2;
  const placed = new Map<string, number>(); // folderPath → beforeLine
  const planned: PlannedInsertion[] = [];

  for (const { question, answer } of [...answered].sort(compareAnswers)) {
    const purpose = sanitizePurpose(answer);
    if (!purpose) continue;
    const parts = question.folderPath.split("/");
    let anchorBeforeLine: number | null = null;
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = anchors.get(prefix);
      if (existing) {
        anchorBeforeLine = existing.blockEndIdx + 2; // 1-based line after the block
        continue;
      }
      const newBeforeLine = placed.get(prefix);
      if (newBeforeLine !== undefined) anchorBeforeLine = newBeforeLine;
    }
    const beforeLine = anchorBeforeLine ?? baseBeforeLine;
    const level = parts.length + 1;
    planned.push({
      beforeLine,
      folderPath: question.folderPath,
      text: `${"#".repeat(level)} ${question.folderPath}/ <!-- ${purpose} -->`,
    });
    placed.set(question.folderPath, beforeLine);
  }

  return planned.sort((a, b) =>
    a.beforeLine !== b.beforeLine ? a.beforeLine - b.beforeLine : a.folderPath.localeCompare(b.folderPath),
  );
}

/** Builds the apply_edits ops that insert the answered purposes into the
 * manifest. A `# vault` H1 line is prepended when the manifest has none
 * (brand-new or non-conforming file). */
export function buildManifestOps(before: string, answered: ClarifyAnswer[]): EditOp[] {
  const lines = before ? before.split("\n") : [];
  const needsH1 = !lines.some(line => /^#{1}\s/.test(line));
  const ops: EditOp[] = [];
  if (needsH1) {
    ops.push({ op: "insert_header", anchor: { before_line: 1 }, text: MANIFEST_H1 });
  }
  for (const insertion of planInsertions(lines, answered)) {
    ops.push({
      op: "insert_header",
      anchor: { before_line: insertion.beforeLine },
      text: insertion.text,
    });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Diff + write
// ---------------------------------------------------------------------------

/** Line-level unified diff (LCS-based, deterministic tie-breaking). */
export function lineDiff(before: string, after: string): string {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`-${a[i]}`);
    i++;
  }
  while (j < m) {
    out.push(`+${b[j]}`);
    j++;
  }
  return out.join("\n");
}

/** Flattens parsed manifest purposes: full path → purpose. */
export function parseFolderPurposes(content: string): Map<string, string> {
  const entries = new TocReader("")._parseContent(content);
  const result = new Map<string, string>();
  const walk = (entry: ManifestEntry, parentPrefix: string): void => {
    const full = resolveEntryPath(parentPrefix, entry.folderPath);
    if (entry.purpose) result.set(full, entry.purpose);
    for (const child of entry.children) walk(child, full);
  };
  for (const entry of entries) walk(entry, "");
  return result;
}

/** The confirmed write — the ONLY disk write in the dialog flow. Guards the
 * round trip: the content must reparse to the same answered purposes before
 * anything is written (the manifest format is structure-sensitive). */
export function writeClarifyProposal(
  vaultPath: string,
  relPath: string,
  proposal: ClarifyProposal,
): void {
  const reparsed = parseFolderPurposes(proposal.after);
  for (const { question, answer } of proposal.answered) {
    if (reparsed.get(question.folderPath) !== answer) {
      throw new Error(`Manifest round-trip failed for ${question.folderPath}`);
    }
  }
  new VaultIO(vaultPath).writeTextAtomic(relPath, proposal.after);
}
