// DatabaseManager — the main-thread async facade and THE ONLY DB entry point.
//
// better-sqlite3 was a native module that could not ship through the plugin
// store (release ships main.js/manifest.json/styles.css only). The engine is
// now sql.js running inside a DISPOSABLE Web Worker: each GraphRAG execution
// spawns a worker, runs, exports, and terminates — worker death frees the
// WASM heap, which never shrinks in-process (sql.js grows ~10× the index size
// while building). The database stays a vault file; bytes cross the worker
// boundary as Transferables, never paths.
//
// Lifecycle (per execution):
//   1. open: read settings.dbPath via the host IO → transfer to the worker.
//      A legacy file (WAL sidecar, unparseable, or user_version < 2) is
//      retired to .note-maintainer/legacy/ and a fresh index is started —
//      the index is derived data, so a one-time rebuild is deterministic.
//   2. ops: every method below awaits a typed worker op.
//   3. close: the worker exports once when dirty; the main thread writes the
//      bytes back via the host IO (temp + rename). Read-only executions
//      never write.
//
// No raw connection may escape this facade — generateManifest's raw queries
// are sealed behind getFolderedFiles / getWikilinksForFolder /
// getFolderHeadings.

import * as path from "path";
import { settings } from "../config";
import { errorMessage } from "../errors";
import { getDefaultDbHost, DbHost, DbChannel } from "./db_host";
import type { DbMethodMap, DbMethodName } from "./db_worker/protocol";
import type {
  CommunityRow,
  CommunityWriteInput,
  Edge,
  EdgeRow,
  EntityRow,
  EntityWriteInput,
  FileRow,
  FileWriteInput,
  FolderFileRow,
  FolderHeadingRow,
  MetaRow,
  SearchResult,
  SectionEntityInput,
  SectionEntityRow,
  SectionKeyRow,
  SectionRow,
  SectionSearchRow,
  SectionSummary,
  SectionWriteInput,
  UnlinkedSection,
  WikilinkCountRow,
} from "./db_worker/types";

export type {
  CommunityRow,
  CommunityWriteInput,
  Edge,
  EdgeRow,
  EntityRow,
  EntityWriteInput,
  FileRow,
  FileWriteInput,
  FolderFileRow,
  FolderHeadingRow,
  MetaRow,
  SearchResult,
  SectionEntityInput,
  SectionEntityRow,
  SectionKeyRow,
  SectionRow,
  SectionSearchRow,
  SectionSummary,
  SectionWriteInput,
  UnlinkedSection,
  WikilinkCountRow,
} from "./db_worker/types";

const DEFAULT_INDEX_WARN_MB = 256;

// Hard reentrancy guarantee for the upgrade flow. retireLegacyIndex must
// never fire the host upgrade hook while another upgrade is still in flight:
// the hook historically triggered a full agent rebuild, which re-entered
// ensureChannel and — when the retire failed to move files — looped until
// the renderer ran out of wasm memory (~108 nested sql.js workers). With the
// rebuild decoupled from the hook this is defense-in-depth, but it makes the
// loop structurally impossible even if a detection bug ever returns.
let legacyUpgradeInFlight = false;

// ---------------------------------------------------------------------------
// DatabaseManager
// ---------------------------------------------------------------------------

export class DatabaseManager {
  readonly dbPath: string;
  private readonly host: DbHost;
  private channel: DbChannel | null = null;
  private upgraded = false;

  /** True when this execution retired a legacy index (see ensureChannel). */
  get didUpgrade(): boolean {
    return this.upgraded;
  }

  constructor(dbPath: string, host?: DbHost) {
    this.dbPath = dbPath;
    this.host = host ?? getDefaultDbHost();
  }

  /**
   * Open (or lazily reopen) the per-execution worker and load the vault DB
   * bytes into it. Retires a legacy index to legacy/ when detected (WAL
   * sidecar present, file unparseable, or user_version < DB_ENGINE_VERSION).
   */
  private async ensureChannel(): Promise<DbChannel> {
    if (this.channel) return this.channel;

    const io = this.host.io;
    const dbPath = this.dbPath;
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);

    // WAL sidecar detection must happen before reading bytes: a legacy
    // better-sqlite3 WAL file may hold uncheckpointed frames that sql.js
    // silently ignores — retire + rebuild is the deterministic path.
    // Listed entries are matched by bare name (basename) because hosts may
    // return vault-relative full paths (Obsidian's DataAdapter.list does) —
    // matching on raw strings silently missed the sidecar and looped.
    if ((await io.listFiles(dir)).some((f) => path.posix.basename(f).startsWith(`${base}-`))) {
      await this.retireLegacyIndex();
    }

    let dbBytes: Uint8Array | null = null;
    if (await io.exists(dbPath)) {
      dbBytes = await io.readBinary(dbPath);
    }

    const wasmBinary = await this.host.loadWasmBinary();
    const channel = await this.host.createChannel(wasmBinary);
    const open = await channel.open(dbBytes);
    if (open.needsRebuild) {
      // Legacy or corrupt file — move it aside and start a fresh index.
      await this.retireLegacyIndex();
      await channel.open(null);
    }

    this.channel = channel;
    // Schema safety: ensure the v2 tables + user_version marker exist.
    await channel.call("initialize");
    return channel;
  }

  /**
   * Retire a legacy index (move index.db* into .note-maintainer/legacy/ and
   * notify the host ONCE). Returns whether anything was actually moved.
   *
   * The host hook must NOT rebuild — a rebuild from inside a DB open path is
   * what caused the recursive loop (nested workers → wasm OOM). The hook only
   * surfaces the one-time event; the caller's own open already continues with
   * a fresh index (derived data — a deterministic one-time rebuild).
   */
  private async retireLegacyIndex(): Promise<boolean> {
    if (legacyUpgradeInFlight) {
      console.warn(
        "[db] index upgrade already in flight — skipping nested legacy retire " +
        "(reentrancy guard).",
      );
      return false;
    }

    legacyUpgradeInFlight = true;
    try {
      const moved = await this.moveLegacyFiles();
      if (moved === 0) {
        // Detection said legacy, but nothing matched — a path-shape or IO bug.
        // Log loudly instead of recursing; the caller still starts a fresh
        // index, which overwrites the legacy file at close (self-healing).
        console.warn(
          `[db] retireLegacyIndex: legacy condition detected for ${this.dbPath} but no ` +
          "files matched — nothing moved. Falling back to a fresh index; " +
          "investigate listFiles/rename if this repeats.",
        );
        return false;
      }

      if (this.host.onIndexUpgraded) {
        await this.host.onIndexUpgraded();
      }
      this.upgraded = true;
      return true;
    } finally {
      legacyUpgradeInFlight = false;
    }
  }

  /** Move every index.db* file in the db dir into legacy/. Best-effort. */
  private async moveLegacyFiles(): Promise<number> {
    const io = this.host.io;
    const dir = path.dirname(this.dbPath);
    const base = path.basename(this.dbPath);
    const legacyDir = path.join(dir, "legacy");
    let moved = 0;
    try {
      await io.mkdirp(legacyDir);
      for (const entry of await io.listFiles(dir)) {
        // Basename-normalize: hosts may list bare names (Node) or full
        // vault-relative paths (Obsidian adapter). Never match raw strings.
        const name = path.posix.basename(entry);
        if (name === base || name.startsWith(`${base}-`)) {
          await io.rename(path.join(dir, name), path.join(legacyDir, name));
          moved++;
        }
      }
    } catch (e) {
      // Best-effort: a failed move must not take down the build. The fresh-
      // index fallback overwrites the legacy file at close, and the loud log
      // surfaces the real problem (a swallowed mkdirp used to hide it).
      console.warn(
        `[db] retireLegacyIndex: file move failed (${errorMessage(e)}) — keeping the ` +
        "legacy index in place and falling back to a fresh index.",
      );
    }
    return moved;
  }

  /**
   * Finalize the execution: export (when dirty) and write the vault file
   * back atomically, then terminate the worker. Idempotent and safe on
   * error paths (no export when an op threw earlier).
   */
  async close(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.channel = null;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await channel.close();
    } finally {
      channel.dispose();
    }
    if (bytes) {
      await this.host.io.mkdirp(path.dirname(this.dbPath));
      await this.host.io.writeBinaryAtomic(this.dbPath, bytes);
      this.warnIfOversize(bytes.byteLength);
    }
  }

  /** Hard teardown without writing back (error paths). */
  dispose(): void {
    if (this.channel) {
      this.channel.dispose();
      this.channel = null;
    }
  }

  private warnIfOversize(byteLength: number): void {
    const warnMb = this.indexSizeWarningMb();
    if (warnMb > 0 && byteLength > warnMb * 1024 * 1024) {
      console.warn(
        `[db] index is ${(byteLength / (1024 * 1024)).toFixed(0)} MB — above the ` +
        `configured ${warnMb} MB warning threshold (index.warn_mb). The in-memory ` +
        "build footprint is ~10× the file size; watch RAM on large vaults.",
      );
    }
  }

  private indexSizeWarningMb(): number {
    const configured = settings.index?.warnMb;
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_INDEX_WARN_MB;
  }

  // ------------------------------------------------------------------
  // Typed op dispatch
  // ------------------------------------------------------------------

  private async callDb<K extends DbMethodName>(
    method: K,
    ...args: DbMethodMap[K]["args"]
  ): Promise<DbMethodMap[K]["result"]> {
    const channel = await this.ensureChannel();
    return channel.call(method, ...args);
  }

  // ------------------------------------------------------------------
  // Facade surface (mirrors the old sync DatabaseManager 1:1)
  // ------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.ensureChannel();
  }

  async clearAll(): Promise<void> {
    await this.callDb("clearAll");
  }

  async upsertFile(fileInfo: FileWriteInput): Promise<void> {
    await this.callDb("upsertFile", fileInfo);
  }

  async updateFileRollup(fileId: string, rollup: string): Promise<void> {
    await this.callDb("updateFileRollup", fileId, rollup);
  }

  async hasFileChanged(fileInfo: FileWriteInput): Promise<boolean> {
    return this.callDb("hasFileChanged", fileInfo);
  }

  async getFileInfo(filePath: string): Promise<FileRow | null> {
    return this.callDb("getFileInfo", filePath);
  }

  async removeFile(filePath: string): Promise<void> {
    await this.callDb("removeFile", filePath);
  }

  async upsertSection(section: SectionWriteInput): Promise<string> {
    return this.callDb("upsertSection", section);
  }

  async retireSections(fileId: string): Promise<number> {
    return this.callDb("retireSections", fileId);
  }

  async getSectionsForFile(fileId: string): Promise<SectionRow[]> {
    return this.callDb("getSectionsForFile", fileId);
  }

  async getAllSections(): Promise<SectionSummary[]> {
    return this.callDb("getAllSections");
  }

  async searchSimilar(queryEmbedding: number[], topK: number = 5): Promise<SearchResult[]> {
    return this.callDb("searchSimilar", queryEmbedding, topK);
  }

  /** Heading-only section rows for the hybrid resolver (no text/blobs). */
  async getSectionKeys(): Promise<SectionKeyRow[]> {
    return this.callDb("getSectionKeys");
  }

  /** All entity names (hybrid resolver's entity-name tier). */
  async getAllEntities(): Promise<EntityRow[]> {
    return this.callDb("getAllEntities");
  }

  /** The sections that mention any of the given entity ids. */
  async getSectionsForEntities(entityIds: string[]): Promise<SectionEntityRow[]> {
    return this.callDb("getSectionsForEntities", entityIds);
  }

  /** Full joined rows (no embedding) for section keys / bare wikilink names. */
  async getSectionsByKeys(keys: string[]): Promise<SectionSearchRow[]> {
    return this.callDb("getSectionsByKeys", keys);
  }

  async insertEntities(entities: EntityWriteInput[]): Promise<void> {
    await this.callDb("insertEntities", entities);
  }

  async insertSectionEntities(sectionKey: string, entities: SectionEntityInput[]): Promise<void> {
    await this.callDb("insertSectionEntities", sectionKey, entities);
  }

  async insertEdges(edges: Edge[]): Promise<void> {
    await this.callDb("insertEdges", edges);
  }

  async getWikilinkEdges(fileId: string): Promise<EdgeRow[]> {
    return this.callDb("getWikilinkEdges", fileId);
  }

  async deleteEdgesForFile(fileId: string): Promise<void> {
    await this.callDb("deleteEdgesForFile", fileId);
  }

  async getUnlinkedSections(): Promise<UnlinkedSection[]> {
    return this.callDb("getUnlinkedSections");
  }

  async insertCommunity(community: CommunityWriteInput): Promise<string> {
    return this.callDb("insertCommunity", community);
  }

  async getAllCommunities(): Promise<CommunityRow[]> {
    return this.callDb("getAllCommunities");
  }

  async assignSectionToCommunity(sectionKey: string, communityId: string): Promise<void> {
    await this.callDb("assignSectionToCommunity", sectionKey, communityId);
  }

  async getCommunityForSection(sectionKey: string): Promise<string | null> {
    return this.callDb("getCommunityForSection", sectionKey);
  }

  async clearCommunityAssignments(): Promise<void> {
    await this.callDb("clearCommunityAssignments");
  }

  async insertMeta(vaultVersion: string, manifestHash: string = ""): Promise<number> {
    return this.callDb("insertMeta", vaultVersion, manifestHash);
  }

  async getLatestMeta(): Promise<MetaRow | null> {
    return this.callDb("getLatestMeta");
  }

  async computeFileRollup(fileId: string): Promise<string | null> {
    return this.callDb("computeFileRollup", fileId);
  }

  // Sealed queries for generateManifest (no raw connection escapes).
  async getFolderedFiles(): Promise<FolderFileRow[]> {
    return this.callDb("getFolderedFiles");
  }

  async getWikilinksForFolder(folder: string): Promise<WikilinkCountRow[]> {
    return this.callDb("getWikilinksForFolder", folder);
  }

  async getFolderHeadings(folder: string): Promise<FolderHeadingRow[]> {
    return this.callDb("getFolderHeadings", folder);
  }
}
