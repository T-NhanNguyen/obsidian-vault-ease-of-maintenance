// SqlJsDatabase — the synchronous SQLite engine that runs inside the
// disposable Web Worker (or, in Node tests, in-process).
//
// This module is PURE by construction: no settings, no VaultIO, no Buffer,
// no Node builtins. It receives a loaded sql.js module and the raw DB bytes
// and exposes the same method surface the old better-sqlite3 DatabaseManager
// had. Every write method marks the database dirty; close() callers export()
// only when dirty, so read-only executions never write the file back.
//
// better-sqlite3 → sql.js mapping used throughout:
//   stmt.run(...)          → db.run(sql, params)
//   .all()                 → prepare + bind + loop step() + getAsObject() + free()
//   .get()                 → prepare + bind + one step() + getAsObject() + free()
//   .run().changes         → db.getRowsModified()
//   result.lastInsertRowid → db.exec("SELECT last_insert_rowid()")
//   conn.exec(sql)         → db.exec(sql)
//   pragma(...)            → db.exec("PRAGMA ...")
//   Buffer blobs           → Uint8Array + DataView (no Buffer in a worker)
//
// journal_mode = WAL is dropped (sql.js has no WAL); foreign_keys = ON is kept.
// DB_ENGINE_VERSION is written as PRAGMA user_version on initialize() —
// future migrations key off it.

import type { Database, SqlJsStatic, Statement, SqlValue } from "sql.js";
import { blobToFloats, floatsToBlob, rankByCosine } from "../embedding";
import type { EmbeddingRow } from "../embedding";
import {
  CommunityReportRow,
  CommunityReportWriteInput,
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
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version marker. Bump + migrate on any schema-affecting change. */
export const DB_ENGINE_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS FILES (
    file_id         TEXT PRIMARY KEY,
    path            TEXT,
    title           TEXT,
    folder          TEXT,
    created_date    TEXT,
    modified_date   TEXT,
    reviewed_date   TEXT,
    owner           TEXT,
    content_type    TEXT,
    granularity     TEXT,
    version         INTEGER DEFAULT 1,
    content_hash    TEXT,
    rollup_summary  TEXT
);

CREATE TABLE IF NOT EXISTS SECTIONS (
    node_key        TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    heading_path    TEXT,
    heading_text    TEXT,
    line_start      INTEGER,
    line_end        INTEGER,
    text            TEXT,
    embedding       BLOB,
    content_hash    TEXT,
    FOREIGN KEY (file_id) REFERENCES FILES(file_id)
);

CREATE TABLE IF NOT EXISTS ENTITIES (
    entity_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS SECTION_ENTITIES (
    section_key TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    PRIMARY KEY (section_key, entity_id),
    FOREIGN KEY (section_key) REFERENCES SECTIONS(node_key),
    FOREIGN KEY (entity_id) REFERENCES ENTITIES(entity_id)
);

CREATE TABLE IF NOT EXISTS EDGES (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    weight      REAL DEFAULT 1.0,
    PRIMARY KEY (src_key, dst_key, kind)
);

CREATE TABLE IF NOT EXISTS COMMUNITIES (
    community_id    TEXT PRIMARY KEY,
    seed_source     TEXT,
    label           TEXT
);

CREATE TABLE IF NOT EXISTS INDEX_META (
    snapshot_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    built_at        TEXT,
    vault_version   TEXT,
    manifest_hash   TEXT
);

CREATE TABLE IF NOT EXISTS COMMUNITY_SECTIONS (
    section_key TEXT NOT NULL,
    community_id TEXT NOT NULL,
    PRIMARY KEY (section_key, community_id),
    FOREIGN KEY (section_key) REFERENCES SECTIONS(node_key),
    FOREIGN KEY (community_id) REFERENCES COMMUNITIES(community_id)
);

-- Community reports are DERIVED data (Phase 4+): an LLM-written markdown
-- summary per community, stored separately from assignment so it can be
-- regenerated without touching COMMUNITY_SECTIONS.
CREATE TABLE IF NOT EXISTS COMMUNITY_REPORTS (
    community_id    TEXT PRIMARY KEY,
    report          TEXT,
    model           TEXT,
    tokens          INTEGER,
    built_at        TEXT,
    FOREIGN KEY (community_id) REFERENCES COMMUNITIES(community_id)
);
`;

const MIGRATED_COLUMNS: Record<string, string[]> = {
  "FILES": ["folder", "reviewed_date", "owner", "content_type", "granularity", "rollup_summary"],
  "INDEX_META": ["manifest_hash"],
};

// ---------------------------------------------------------------------------
// Private row shapes (never cross the worker boundary)
// ---------------------------------------------------------------------------

interface NameOnlyRow {
  name: string;
}

interface SectionEmbeddingRow {
  node_key: string;
  file_id: string;
  heading_path: string | null;
  text: string | null;
  embedding: Uint8Array | null;
}

interface UnlinkedSectionRow {
  node_key: string;
  file_id: string;
  embedding: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Statement helpers
// ---------------------------------------------------------------------------

function queryAll<T>(stmt: Statement, params: SqlValue[] = []): T[] {
  if (params.length > 0) stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

function queryOne<T>(stmt: Statement, params: SqlValue[] = []): T | null {
  if (params.length > 0) stmt.bind(params);
  let row: T | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject() as T;
  }
  stmt.free();
  return row;
}

/** Prepared-statement bulk writer: bind + step + reset per row, free once. */
function runMany(conn: Database, sql: string, rows: Array<SqlValue[]>): void {
  if (rows.length === 0) return;
  const stmt = conn.prepare(sql);
  try {
    for (const params of rows) {
      stmt.run(params);
    }
  } finally {
    stmt.free();
  }
}

function readUserVersion(conn: Database): number {
  const result = conn.exec("PRAGMA user_version");
  const value = result[0]?.values[0]?.[0];
  return typeof value === "number" ? value : 0;
}

// ---------------------------------------------------------------------------
// SqlJsDatabase
// ---------------------------------------------------------------------------

export class SqlJsDatabase {
  private constructor(
    private readonly sql: SqlJsStatic,
    private readonly conn: Database,
    private dirty: boolean,
  ) {}

  /**
   * Open a database from raw bytes (or start empty). Returns null when the
   * bytes are NOT a sql.js-compatible current-engine database — either the
   * file does not parse, or PRAGMA user_version is below DB_ENGINE_VERSION
   * (a legacy index from an older engine). The caller then retires the file to
   * legacy/ and rebuilds — see the facade's upgrade flow.
   */
  static create(sql: SqlJsStatic, dbBytes: Uint8Array | null): SqlJsDatabase | null {
    let conn: Database | null = null;
    if (dbBytes && dbBytes.byteLength > 0) {
      try {
        conn = new sql.Database(dbBytes);
        if (readUserVersion(conn) < DB_ENGINE_VERSION) {
          conn.close();
          return null; // legacy engine file → retire + rebuild
        }
      } catch {
        // Not a valid SQLite file (sql.js may throw at the first statement)
        // → retire + rebuild.
        if (conn) {
          try {
            conn.close();
          } catch {
            // broken handle — nothing else to release here
          }
        }
        return null;
      }
    } else {
      conn = new sql.Database();
    }
    return new SqlJsDatabase(sql, conn, false);
  }

  isDirty(): boolean {
    return this.dirty;
  }

  export(): Uint8Array {
    return this.conn.export();
  }

  close(): void {
    this.conn.close();
    this.dirty = false;
  }

  // ------------------------------------------------------------------
  // Schema / lifecycle
  // ------------------------------------------------------------------

  initialize(): void {
    const existing = new Set<string>(
      queryAll<NameOnlyRow>(this.conn.prepare("SELECT name FROM sqlite_master WHERE type='table'"))
        .map((r) => r.name),
    );

    const v1Tables = new Set<string>();
    if (existing.has("CHUNKS")) v1Tables.add("CHUNKS");
    if (existing.has("CHUNK_ENTITIES")) v1Tables.add("CHUNK_ENTITIES");

    // Check if FILES needs migration (missing file_id column)
    if (existing.has("FILES")) {
      const cols = queryAll<NameOnlyRow>(this.conn.prepare("PRAGMA table_info(FILES)"))
        .map((r) => r.name);
      if (!cols.includes("file_id")) {
        v1Tables.add("FILES");
        v1Tables.add("EDGES");
        v1Tables.add("INDEX_META");
      }
    }

    // Drop v1 tables in dependency order
    const dropOrder = ["CHUNK_ENTITIES", "CHUNKS", "EDGES", "INDEX_META", "FILES"];
    let changed = false;
    for (const table of dropOrder) {
      if (v1Tables.has(table)) {
        this.conn.run(`DROP TABLE IF EXISTS ${table}`);
        changed = true;
      }
    }

    // Create the current-engine schema
    this.conn.exec(SCHEMA_SQL);
    if (this.ensureMigratedColumns()) changed = true;

    const version = readUserVersion(this.conn);
    if (version < DB_ENGINE_VERSION) {
      this.conn.run(`PRAGMA user_version = ${DB_ENGINE_VERSION}`);
      changed = true;
    }

    if (changed) this.dirty = true;
  }

  private ensureMigratedColumns(): boolean {
    let changed = false;
    for (const [table, columns] of Object.entries(MIGRATED_COLUMNS)) {
      const existing = new Set<string>(
        queryAll<NameOnlyRow>(this.conn.prepare(`PRAGMA table_info(${table})`))
          .map((r) => r.name),
      );
      for (const col of columns) {
        if (!existing.has(col)) {
          this.conn.run(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
          changed = true;
        }
      }
    }
    return changed;
  }

  clearAll(): void {
    const tables = [
      // Reports reference COMMUNITIES, so they must go before it.
      "COMMUNITY_REPORTS", "COMMUNITY_SECTIONS", "SECTION_ENTITIES",
      "SECTIONS", "EDGES", "ENTITIES", "COMMUNITIES", "FILES", "INDEX_META",
    ];
    for (const table of tables) {
      this.conn.run(`DELETE FROM ${table}`);
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // File operations
  // ------------------------------------------------------------------

  upsertFile(fileInfo: FileWriteInput): void {
    this.conn.run(
      `INSERT OR REPLACE INTO FILES
       (file_id, path, title, folder, created_date, modified_date,
        reviewed_date, owner, content_type, granularity,
        version, content_hash, rollup_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileInfo.file_id || fileInfo.path || "",
        fileInfo.path || "",
        fileInfo.title || "",
        fileInfo.folder || "",
        fileInfo.created_date || null,
        fileInfo.modified_date || null,
        fileInfo.reviewed_date || null,
        fileInfo.owner || "",
        fileInfo.content_type || "",
        fileInfo.granularity || "",
        fileInfo.version || 1,
        fileInfo.content_hash || null,
        fileInfo.rollup_summary || "",
      ],
    );
    this.dirty = true;
  }

  updateFileRollup(fileId: string, rollup: string): void {
    this.conn.run("UPDATE FILES SET rollup_summary = ? WHERE file_id = ?", [rollup, fileId]);
    this.dirty = true;
  }

  hasFileChanged(fileInfo: FileWriteInput): boolean {
    const fileId = fileInfo.file_id || fileInfo.path || "";
    const row = queryOne<{ content_hash: string | null }>(
      this.conn.prepare("SELECT content_hash FROM FILES WHERE file_id = ?"),
      [fileId],
    );
    return !row || row.content_hash !== fileInfo.content_hash;
  }

  getFileInfo(filePath: string): FileRow | null {
    return queryOne<FileRow>(this.conn.prepare("SELECT * FROM FILES WHERE file_id = ?"), [filePath]);
  }

  removeFile(filePath: string): void {
    this.conn.run(
      "DELETE FROM SECTION_ENTITIES WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)",
      [filePath],
    );
    this.conn.run(
      "DELETE FROM COMMUNITY_SECTIONS WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)",
      [filePath],
    );
    this.conn.run("DELETE FROM SECTIONS WHERE file_id = ?", [filePath]);
    this.conn.run("DELETE FROM EDGES WHERE src_key = ? OR dst_key = ?", [filePath, filePath]);
    this.conn.run("DELETE FROM FILES WHERE file_id = ?", [filePath]);
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // Section operations
  // ------------------------------------------------------------------

  upsertSection(section: SectionWriteInput): string {
    const emb = section.embedding;
    const embBlob = emb ? floatsToBlob(emb) : new Uint8Array(0);
    this.conn.run(
      `INSERT OR REPLACE INTO SECTIONS
       (node_key, file_id, heading_path, heading_text,
        line_start, line_end, text, embedding, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        section.nodeKey || "",
        section.fileId || "",
        section.headingPath || section.heading_path || "",
        section.headingText || section.heading_text || "",
        section.lineStart || section.line_start || 0,
        section.lineEnd || section.line_end || 0,
        section.text || "",
        embBlob,
        section.contentHash || section.content_hash || "",
      ],
    );
    this.dirty = true;
    return section.nodeKey || "";
  }

  retireSections(fileId: string): number {
    this.conn.run(
      "DELETE FROM SECTION_ENTITIES WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)",
      [fileId],
    );
    this.conn.run(
      "DELETE FROM COMMUNITY_SECTIONS WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)",
      [fileId],
    );
    this.conn.run("DELETE FROM SECTIONS WHERE file_id = ?", [fileId]);
    this.dirty = true;
    return this.conn.getRowsModified();
  }

  getSectionsForFile(fileId: string): SectionRow[] {
    return queryAll<SectionRow>(this.conn.prepare("SELECT * FROM SECTIONS WHERE file_id = ?"), [fileId]);
  }

  getAllSections(): SectionSummary[] {
    const rows = queryAll<SectionEmbeddingRow>(
      this.conn.prepare(
        "SELECT node_key, file_id, heading_path, text, embedding FROM SECTIONS WHERE embedding IS NOT NULL",
      ),
    );
    return rows.map((row) => ({
      nodeKey: row.node_key,
      fileId: row.file_id,
      headingPath: row.heading_path,
      text: row.text,
      embedding: blobToFloats(row.embedding),
    }));
  }

  searchSimilar(queryEmbedding: number[], topK: number): SearchResult[] {
    const rows = queryAll<EmbeddingRow>(this.conn.prepare(`
      SELECT s.node_key, s.file_id, s.heading_path, s.heading_text,
             s.line_start, s.line_end, s.text, s.embedding, s.content_hash,
             f.path, f.title, f.content_type, f.rollup_summary
      FROM SECTIONS s JOIN FILES f ON s.file_id = f.file_id
      WHERE s.embedding IS NOT NULL
    `));
    // Pure row read above; cosine ranking lives in the embedding concern.
    return rankByCosine(queryEmbedding, rows, topK);
  }

  // ------------------------------------------------------------------
  // Graph-search reads (query-time graph expansion — see graph_search.ts)
  // ------------------------------------------------------------------

  /** Heading-only section rows for the resolver (never loads text/blobs). */
  getSectionKeys(): SectionKeyRow[] {
    return queryAll<SectionKeyRow>(
      this.conn.prepare(
        "SELECT node_key, file_id, heading_path, heading_text FROM SECTIONS ORDER BY node_key",
      ),
    );
  }

  /** All entity names (the resolver's entity-name matching tier). */
  getAllEntities(): EntityRow[] {
    return queryAll<EntityRow>(
      this.conn.prepare("SELECT entity_id, name FROM ENTITIES ORDER BY entity_id"),
    );
  }

  /** The sections that mention any of the given entity ids (IN lookup). */
  getSectionsForEntities(entityIds: string[]): SectionEntityRow[] {
    if (entityIds.length === 0) return [];
    return queryAll<SectionEntityRow>(
      this.conn.prepare(
        `SELECT section_key, entity_id FROM SECTION_ENTITIES
         WHERE entity_id IN (${entityIds.map(() => "?").join(",")})`,
      ),
      entityIds,
    );
  }

  /**
   * Full joined rows (no embedding) for specific keys. Keys are either
   * section keys ("file.md::Heading") or bare wikilink targets / file names
   * ("datacenter-power-demand", "notes/a.md") — the EDGES graph stores the
   * latter, so resolution matches sections by exact node_key or by the
   * file's basename without the .md extension (Obsidian-style wikilinks).
   */
  getSectionsByKeys(keys: string[]): SectionSearchRow[] {
    if (keys.length === 0) return [];
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const sectionKeys: string[] = [];
    for (const key of keys) {
      if (key.includes("::")) {
        sectionKeys.push(key);
      } else {
        const bare = key.endsWith(".md") ? key.slice(0, -3) : key;
        // Exact path ("notes/a.md") or basename match in any folder ("a.md").
        clauses.push("(s.file_id = ? OR s.file_id LIKE ?)");
        params.push(`${bare}.md`, `%/${bare}.md`);
      }
    }
    if (sectionKeys.length > 0) {
      clauses.push(`s.node_key IN (${sectionKeys.map(() => "?").join(",")})`);
      params.push(...sectionKeys);
    }
    return queryAll<SectionSearchRow>(
      this.conn.prepare(`
        SELECT s.node_key, s.file_id, s.heading_path, s.heading_text,
               s.line_start, s.line_end, s.text, s.content_hash,
               f.path, f.title, f.content_type, f.rollup_summary
        FROM SECTIONS s JOIN FILES f ON s.file_id = f.file_id
        WHERE (${clauses.join(" OR ")})
        ORDER BY s.node_key
      `),
      params,
    );
  }

  // ------------------------------------------------------------------
  // Entity operations
  // ------------------------------------------------------------------

  insertEntities(entities: EntityWriteInput[]): void {
    runMany(
      this.conn,
      "INSERT OR IGNORE INTO ENTITIES (entity_id, name, type) VALUES (?, ?, ?)",
      entities.map((ent) => [ent.entityId, ent.name, ent.type || "unknown"]),
    );
    this.dirty = true;
  }

  insertSectionEntities(sectionKey: string, entities: SectionEntityInput[]): void {
    runMany(
      this.conn,
      "INSERT OR IGNORE INTO SECTION_ENTITIES (section_key, entity_id) VALUES (?, ?)",
      entities.map((ent) => [sectionKey, ent.entityId]),
    );
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // Edge operations
  // ------------------------------------------------------------------

  insertEdges(edges: Edge[]): void {
    runMany(
      this.conn,
      "INSERT OR REPLACE INTO EDGES (src_key, dst_key, kind, weight) VALUES (?, ?, ?, ?)",
      edges.map((edge) => [edge.srcKey, edge.dstKey, edge.kind, edge.weight]),
    );
    this.dirty = true;
  }

  getWikilinkEdges(fileId: string): EdgeRow[] {
    return queryAll<EdgeRow>(
      this.conn.prepare(
        `SELECT src_key, dst_key, kind, weight FROM EDGES
         WHERE kind IN ('wikilink', 'backlink') AND (src_key = ? OR src_key LIKE ?)`,
      ),
      [fileId, `${fileId}::%`],
    );
  }

  deleteEdgesForFile(fileId: string): void {
    this.conn.run(
      "DELETE FROM EDGES WHERE src_key = ? OR src_key LIKE ? OR dst_key = ? OR dst_key LIKE ?",
      [fileId, `${fileId}::%`, fileId, `${fileId}::%`],
    );
    this.dirty = true;
  }

  getUnlinkedSections(): UnlinkedSection[] {
    const rows = queryAll<UnlinkedSectionRow>(this.conn.prepare(`
      SELECT s.node_key, s.file_id, s.embedding
      FROM SECTIONS s
      WHERE s.node_key NOT IN (
        SELECT src_key FROM EDGES WHERE kind IN ('wikilink', 'backlink')
        UNION
        SELECT dst_key FROM EDGES WHERE kind IN ('wikilink', 'backlink')
      )
    `));
    return rows.map((r) => ({
      nodeKey: r.node_key,
      fileId: r.file_id,
      embedding: blobToFloats(r.embedding),
    }));
  }

  // ------------------------------------------------------------------
  // Community operations
  // ------------------------------------------------------------------

  insertCommunity(community: CommunityWriteInput): string {
    this.conn.run(
      "INSERT OR REPLACE INTO COMMUNITIES (community_id, seed_source, label) VALUES (?, ?, ?)",
      [
        community.communityId || community.community_id || "",
        community.seedSource || community.seed_source || "unsupervised",
        community.label || "",
      ],
    );
    this.dirty = true;
    return community.communityId || community.community_id || "";
  }

  getAllCommunities(): CommunityRow[] {
    return queryAll<CommunityRow>(this.conn.prepare("SELECT * FROM COMMUNITIES ORDER BY community_id"));
  }

  assignSectionToCommunity(sectionKey: string, communityId: string): void {
    this.conn.run(
      "INSERT OR IGNORE INTO COMMUNITY_SECTIONS (section_key, community_id) VALUES (?, ?)",
      [sectionKey, communityId],
    );
    this.dirty = true;
  }

  getCommunityForSection(sectionKey: string): string | null {
    const row = queryOne<{ community_id: string }>(
      this.conn.prepare("SELECT community_id FROM COMMUNITY_SECTIONS WHERE section_key = ?"),
      [sectionKey],
    );
    return row ? row.community_id : null;
  }

  clearCommunityAssignments(): void {
    this.conn.run("DELETE FROM COMMUNITY_SECTIONS");
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // Community report operations (Phase 4 — LLM-written summaries)
  // ------------------------------------------------------------------

  upsertCommunityReport(report: CommunityReportWriteInput): void {
    this.conn.run(
      `INSERT OR REPLACE INTO COMMUNITY_REPORTS
       (community_id, report, model, tokens, built_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        report.communityId || report.community_id || "",
        report.report || "",
        report.model || "",
        typeof report.tokens === "number" ? report.tokens : null,
        report.builtAt || report.built_at || new Date().toISOString(),
      ],
    );
    this.dirty = true;
  }

  getCommunityReport(communityId: string): CommunityReportRow | null {
    return queryOne<CommunityReportRow>(
      this.conn.prepare("SELECT * FROM COMMUNITY_REPORTS WHERE community_id = ?"),
      [communityId],
    );
  }

  getAllCommunityReports(): CommunityReportRow[] {
    return queryAll<CommunityReportRow>(
      this.conn.prepare("SELECT * FROM COMMUNITY_REPORTS ORDER BY community_id"),
    );
  }

  /**
   * The member sections of a community (joined with FILES, no embedding) —
   * the input to report generation. Deterministic: ordered by node_key.
   */
  getSectionsForCommunity(communityId: string): SectionSearchRow[] {
    return queryAll<SectionSearchRow>(
      this.conn.prepare(`
        SELECT s.node_key, s.file_id, s.heading_path, s.heading_text,
               s.line_start, s.line_end, s.text, s.content_hash,
               f.path, f.title, f.content_type, f.rollup_summary
        FROM COMMUNITY_SECTIONS cs
        JOIN SECTIONS s ON cs.section_key = s.node_key
        JOIN FILES f ON s.file_id = f.file_id
        WHERE cs.community_id = ?
        ORDER BY s.node_key
      `),
      [communityId],
    );
  }

  // ------------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------------

  insertMeta(vaultVersion: string, manifestHash: string = ""): number {
    const now = new Date().toISOString();
    this.conn.run(
      "INSERT INTO INDEX_META (built_at, vault_version, manifest_hash) VALUES (?, ?, ?)",
      [now, vaultVersion, manifestHash],
    );
    this.dirty = true;
    const row = this.conn.exec("SELECT last_insert_rowid() AS id");
    return Number(row[0]?.values[0]?.[0] ?? 0);
  }

  getLatestMeta(): MetaRow | null {
    return queryOne<MetaRow>(
      this.conn.prepare("SELECT * FROM INDEX_META ORDER BY snapshot_id DESC LIMIT 1"),
    );
  }

  // ------------------------------------------------------------------
  // Rollup helpers
  // ------------------------------------------------------------------

  computeFileRollup(fileId: string): string | null {
    const sections = this.getSectionsForFile(fileId);
    if (sections.length === 0) return "";
    const fileInfo = this.getFileInfo(fileId);
    if (fileInfo && fileInfo.granularity === "verbatim") return null;
    const headings: string[] = [];
    for (const s of sections) {
      const hp = s.heading_path || "";
      if (hp) {
        headings.push(hp.split(" › ").pop() || "");
      }
    }
    if (headings.length > 0) {
      return "Sections: " + headings.slice(0, 10).join(", ");
    }
    return "";
  }

  // ------------------------------------------------------------------
  // Sealed read queries for generateManifest (no raw connection escapes)
  // ------------------------------------------------------------------

  getFolderedFiles(): FolderFileRow[] {
    return queryAll<FolderFileRow>(
      this.conn.prepare("SELECT folder, path FROM FILES WHERE folder != '' ORDER BY folder, path"),
    );
  }

  getWikilinksForFolder(folder: string): WikilinkCountRow[] {
    return queryAll<WikilinkCountRow>(
      this.conn.prepare(`
        SELECT e.name, COUNT(*) as cnt
        FROM ENTITIES e
        JOIN SECTION_ENTITIES se ON e.entity_id = se.entity_id
        JOIN SECTIONS s ON se.section_key = s.node_key
        JOIN FILES f ON s.file_id = f.file_id
        WHERE f.folder = ? AND e.type = 'wikilink'
        GROUP BY e.name ORDER BY cnt DESC LIMIT 6
      `),
      [folder],
    );
  }

  getFolderHeadings(folder: string): FolderHeadingRow[] {
    return queryAll<FolderHeadingRow>(
      this.conn.prepare(`
        SELECT s.heading_path, s.text
        FROM SECTIONS s JOIN FILES f ON s.file_id = f.file_id
        WHERE f.folder = ? AND s.heading_path != '' AND s.text != ''
        LIMIT 3
      `),
      [folder],
    );
  }
}
