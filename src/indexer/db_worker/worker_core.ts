// DbWorkerCore — the synchronous sql.js executor shared by BOTH the real Web
// Worker (worker.ts) and the in-process Node channel (db_host.ts). Keeping
// the dispatch here means the protocol implementation exists once; the worker
// is just a postMessage shim around this class.
//
// sql.js is loaded with a LAZY dynamic import: the plugin's main bundle marks
// "sql.js" as external (esbuild keeps `require("sql.js")` inside the dynamic
// import, never executed in Obsidian — the worker path has sql.js inlined by
// the worker esbuild pass), while the in-process channel (tests / plain Node)
// resolves it from node_modules at first use.

import type { SqlJsConfig, SqlJsStatic } from "sql.js";
import type { DbMethodName } from "./protocol";
import { SqlJsDatabase } from "./sqljs_database";
import type {
  CommunityWriteInput,
  Edge,
  EntityWriteInput,
  FileWriteInput,
  SectionEntityInput,
  SectionWriteInput,
} from "./types";

export interface OpenResult {
  needsRebuild: boolean;
}

type DbMethodFn = (db: SqlJsDatabase, args: unknown[]) => unknown;

const METHOD_DISPATCH: Record<string, DbMethodFn> = {
  initialize: (db) => db.initialize(),
  clearAll: (db) => db.clearAll(),
  upsertFile: (db, args) => db.upsertFile(args[0] as FileWriteInput),
  updateFileRollup: (db, args) => db.updateFileRollup(args[0] as string, args[1] as string),
  hasFileChanged: (db, args) => db.hasFileChanged(args[0] as FileWriteInput),
  getFileInfo: (db, args) => db.getFileInfo(args[0] as string),
  removeFile: (db, args) => db.removeFile(args[0] as string),
  upsertSection: (db, args) => db.upsertSection(args[0] as SectionWriteInput),
  retireSections: (db, args) => db.retireSections(args[0] as string),
  getSectionsForFile: (db, args) => db.getSectionsForFile(args[0] as string),
  getAllSections: (db) => db.getAllSections(),
  searchSimilar: (db, args) => db.searchSimilar(args[0] as number[], args[1] as number),
  getSectionKeys: (db) => db.getSectionKeys(),
  getAllEntities: (db) => db.getAllEntities(),
  getSectionsForEntities: (db, args) => db.getSectionsForEntities(args[0] as string[]),
  getSectionsByKeys: (db, args) => db.getSectionsByKeys(args[0] as string[]),
  insertEntities: (db, args) => db.insertEntities(args[0] as EntityWriteInput[]),
  insertSectionEntities: (db, args) => db.insertSectionEntities(args[0] as string, args[1] as SectionEntityInput[]),
  insertEdges: (db, args) => db.insertEdges(args[0] as Edge[]),
  getWikilinkEdges: (db, args) => db.getWikilinkEdges(args[0] as string),
  deleteEdgesForFile: (db, args) => db.deleteEdgesForFile(args[0] as string),
  getUnlinkedSections: (db) => db.getUnlinkedSections(),
  insertCommunity: (db, args) => db.insertCommunity(args[0] as CommunityWriteInput),
  getAllCommunities: (db) => db.getAllCommunities(),
  assignSectionToCommunity: (db, args) => db.assignSectionToCommunity(args[0] as string, args[1] as string),
  getCommunityForSection: (db, args) => db.getCommunityForSection(args[0] as string),
  clearCommunityAssignments: (db) => db.clearCommunityAssignments(),
  insertMeta: (db, args) => db.insertMeta(args[0] as string, args[1] as string),
  getLatestMeta: (db) => db.getLatestMeta(),
  computeFileRollup: (db, args) => db.computeFileRollup(args[0] as string),
  getFolderedFiles: (db) => db.getFolderedFiles(),
  getWikilinksForFolder: (db, args) => db.getWikilinksForFolder(args[0] as string),
  getFolderHeadings: (db, args) => db.getFolderHeadings(args[0] as string),
};

// ---------------------------------------------------------------------------
// sql.js loading
// ---------------------------------------------------------------------------

type InitSqlJsFn = (config?: SqlJsConfig) => Promise<SqlJsStatic>;

let initSqlJsPromise: Promise<InitSqlJsFn> | null = null;

function loadInitSqlJs(): Promise<InitSqlJsFn> {
  if (!initSqlJsPromise) {
    initSqlJsPromise = import("sql.js").then((mod) => mod.default as InitSqlJsFn);
  }
  return initSqlJsPromise;
}

/** Copy to an exact-size ArrayBuffer (trailing bytes break wasm validation). */
function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// DbWorkerCore
// ---------------------------------------------------------------------------

export class DbWorkerCore {
  private sql: SqlJsStatic | null = null;
  private db: SqlJsDatabase | null = null;

  constructor(private readonly wasmBinary: Uint8Array | null) {}

  /** Load sql.js + the DB bytes. Returns needsRebuild for legacy files. */
  async open(dbBytes: Uint8Array | null): Promise<OpenResult> {
    this.dispose();
    const sql = await this.initSqlJs();
    const created = SqlJsDatabase.create(sql, dbBytes);
    if (!created) return { needsRebuild: true };
    this.db = created;
    return { needsRebuild: false };
  }

  call(method: DbMethodName, args: unknown[]): unknown {
    if (!this.db) {
      throw new Error("DbWorkerCore: database not open (open() must run before any op)");
    }
    const fn = METHOD_DISPATCH[method];
    if (!fn) {
      throw new Error(`DbWorkerCore: unknown method '${String(method)}'`);
    }
    return fn(this.db, args);
  }

  /** Export the database bytes when it was modified, else null. */
  close(): Uint8Array | null {
    if (!this.db) return null;
    let bytes: Uint8Array | null = null;
    try {
      if (this.db.isDirty()) {
        bytes = this.db.export();
      }
    } finally {
      this.db.close();
      this.db = null;
    }
    return bytes;
  }

  /** Hard teardown without exporting (error paths). */
  dispose(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // best-effort — the wasm heap is reclaimed with the worker/context
      }
      this.db = null;
    }
    this.sql = null;
  }

  private async initSqlJs(): Promise<SqlJsStatic> {
    if (this.sql) return this.sql;
    const init = await loadInitSqlJs();
    const config: SqlJsConfig = this.wasmBinary
      ? { wasmBinary: toExactArrayBuffer(this.wasmBinary) }
      : {};
    this.sql = await init(config);
    return this.sql;
  }
}
