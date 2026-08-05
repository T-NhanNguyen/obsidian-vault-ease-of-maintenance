// SQLite database manager for v2 GraphRAG schema.
// Ported from src/indexer/db.py
// Uses better-sqlite3 — native C binding, same speed as Python's sqlite3.
// The module is REQUIRED LAZILY (first connect) so a native-module load
// issue can never block plugin startup — the DB is only used on demand.

import type Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { settings } from "../config";

// Obsidian's plugin loader does not resolve bare specifiers from the plugin's
// node_modules (error: "Cannot find module 'better-sqlite3'" with require stack
// electron/js2c/renderer_init). Resolve by absolute path derived from the vault;
// bare require stays first so tests/dev under plain Node keep working.
const PLUGIN_ID = "obsidian-vault-ease-of-maintenance";

function resolveBetterSqlite3(): typeof Database {
  try {
    return require("better-sqlite3");
  } catch (bareErr) {
    const candidates: string[] = [];
    const vault = settings.vaultPath;
    if (vault) {
      candidates.push(
        path.join(vault, ".obsidian", "plugins", PLUGIN_ID, "node_modules", "better-sqlite3")
      );
    }
    if (typeof __dirname === "string" && __dirname) {
      candidates.push(path.join(__dirname, "node_modules", "better-sqlite3"));
    }
    for (const c of candidates) {
      try {
        return require(c);
      } catch (e) {
        console.error(`[db] better-sqlite3 candidate failed: ${c} -> ${(e as Error).message}`);
      }
    }
    throw bareErr instanceof Error ? bareErr : new Error(String(bareErr));
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
`;

const MIGRATED_COLUMNS: Record<string, string[]> = {
  "FILES": ["folder", "reviewed_date", "owner", "content_type", "granularity", "rollup_summary"],
  "INDEX_META": ["manifest_hash"],
};

// ---------------------------------------------------------------------------
// DatabaseManager
// ---------------------------------------------------------------------------

export class DatabaseManager {
  dbPath: string;
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private connect(): Database.Database {
    if (this.db) return this.db;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Lazy require: keeps better-sqlite3 out of the plugin's load-time
    // require chain (see file header comment).
    const DatabaseCtor = resolveBetterSqlite3();
    this.db = new DatabaseCtor(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    return this.db;
  }

  initialize(): void {
    const conn = this.connect();

    // Check existing tables
    const existing = new Set(
      conn.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name)
    );

    const v1Tables = new Set<string>();
    if (existing.has("CHUNKS")) v1Tables.add("CHUNKS");
    if (existing.has("CHUNK_ENTITIES")) v1Tables.add("CHUNK_ENTITIES");

    // Check if FILES needs migration (missing file_id column)
    if (existing.has("FILES")) {
      const cols = conn.prepare("PRAGMA table_info(FILES)").all()
        .map((r: any) => r.name);
      if (!cols.includes("file_id")) {
        v1Tables.add("FILES");
        v1Tables.add("EDGES");
        v1Tables.add("INDEX_META");
      }
    }

    // Drop v1 tables in dependency order
    const dropOrder = ["CHUNK_ENTITIES", "CHUNKS", "EDGES", "INDEX_META", "FILES"];
    for (const table of dropOrder) {
      if (v1Tables.has(table)) {
        conn.prepare(`DROP TABLE IF EXISTS ${table}`).run();
        console.log(`  [db] Migrated: dropped v1 table ${table}`);
      }
    }

    // Create v2 schema
    conn.exec(SCHEMA_SQL);
    this.ensureMigratedColumns(conn);
  }

  private ensureMigratedColumns(conn: Database.Database): void {
    for (const [table, columns] of Object.entries(MIGRATED_COLUMNS)) {
      const existing = new Set(
        conn.prepare(`PRAGMA table_info(${table})`).all()
          .map((r: any) => r.name)
      );
      for (const col of columns) {
        if (!existing.has(col)) {
          conn.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`).run();
          console.log(`  [db] Migrated: added ${table}.${col}`);
        }
      }
    }
  }

  clearAll(): void {
    const conn = this.connect();
    const tables = [
      "COMMUNITY_SECTIONS", "SECTION_ENTITIES", "SECTIONS", "EDGES",
      "ENTITIES", "COMMUNITIES", "FILES", "INDEX_META",
    ];
    for (const table of tables) {
      conn.prepare(`DELETE FROM ${table}`).run();
    }
  }

  // ------------------------------------------------------------------
  // File operations
  // ------------------------------------------------------------------

  upsertFile(fileInfo: Record<string, any>): void {
    const conn = this.connect();
    conn.prepare(`
      INSERT OR REPLACE INTO FILES
      (file_id, path, title, folder, created_date, modified_date,
       reviewed_date, owner, content_type, granularity,
       version, content_hash, rollup_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    );
  }

  updateFileRollup(fileId: string, rollup: string): void {
    const conn = this.connect();
    conn.prepare("UPDATE FILES SET rollup_summary = ? WHERE file_id = ?")
      .run(rollup, fileId);
  }

  hasFileChanged(fileInfo: Record<string, any>): boolean {
    const conn = this.connect();
    const fileId = fileInfo.file_id || fileInfo.path || "";
    const row = conn.prepare("SELECT content_hash FROM FILES WHERE file_id = ?")
      .get(fileId) as any;
    return !row || row.content_hash !== fileInfo.content_hash;
  }

  getFileInfo(filePath: string): Record<string, any> | null {
    const conn = this.connect();
    return conn.prepare("SELECT * FROM FILES WHERE file_id = ?").get(filePath) as any || null;
  }

  removeFile(filePath: string): void {
    const conn = this.connect();
    conn.prepare(
      "DELETE FROM SECTION_ENTITIES WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)"
    ).run(filePath);
    conn.prepare(
      "DELETE FROM COMMUNITY_SECTIONS WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)"
    ).run(filePath);
    conn.prepare("DELETE FROM SECTIONS WHERE file_id = ?").run(filePath);
    conn.prepare("DELETE FROM EDGES WHERE src_key = ? OR dst_key = ?").run(filePath, filePath);
    conn.prepare("DELETE FROM FILES WHERE file_id = ?").run(filePath);
  }

  // ------------------------------------------------------------------
  // Section operations
  // ------------------------------------------------------------------

  static floatsToBlob(emb: number[]): Buffer {
    const buf = Buffer.allocUnsafe(emb.length * 8);
    for (let i = 0; i < emb.length; i++) {
      buf.writeDoubleLE(emb[i], i * 8);
    }
    return buf;
  }

  upsertSection(section: Record<string, any>): string {
    const conn = this.connect();
    const emb = section.embedding;
    const embBlob = emb ? DatabaseManager.floatsToBlob(emb) : Buffer.alloc(0);
    conn.prepare(`
      INSERT OR REPLACE INTO SECTIONS
      (node_key, file_id, heading_path, heading_text,
       line_start, line_end, text, embedding, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      section.nodeKey,
      section.fileId,
      section.headingPath || section.heading_path || "",
      section.headingText || section.heading_text || "",
      section.lineStart || section.line_start || 0,
      section.lineEnd || section.line_end || 0,
      section.text || "",
      embBlob,
      section.contentHash || section.content_hash || "",
    );
    return section.nodeKey;
  }

  retireSections(fileId: string): number {
    const conn = this.connect();
    conn.prepare(
      "DELETE FROM SECTION_ENTITIES WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)"
    ).run(fileId);
    conn.prepare(
      "DELETE FROM COMMUNITY_SECTIONS WHERE section_key IN (SELECT node_key FROM SECTIONS WHERE file_id = ?)"
    ).run(fileId);
    const result = conn.prepare("DELETE FROM SECTIONS WHERE file_id = ?").run(fileId);
    return result.changes;
  }

  getSectionsForFile(fileId: string): Record<string, any>[] {
    const conn = this.connect();
    return conn.prepare("SELECT * FROM SECTIONS WHERE file_id = ?").all(fileId) as any[];
  }

  getAllSections(): Record<string, any>[] {
    const conn = this.connect();
    const rows = conn.prepare(
      "SELECT node_key, file_id, heading_path, text, embedding FROM SECTIONS WHERE embedding IS NOT NULL"
    ).all() as any[];
    return rows.map((row: any) => ({
      nodeKey: row.node_key,
      fileId: row.file_id,
      headingPath: row.heading_path,
      text: row.text,
      embedding: DatabaseManager.blobToFloats(row.embedding),
    }));
  }

  searchSimilar(queryEmbedding: number[], topK: number = 5): SearchResult[] {
    const conn = this.connect();
    const rows = conn.prepare(`
      SELECT s.node_key, s.file_id, s.heading_path, s.heading_text,
             s.line_start, s.line_end, s.text, s.embedding, s.content_hash,
             f.path, f.title, f.content_type, f.rollup_summary, f.content_hash
      FROM SECTIONS s JOIN FILES f ON s.file_id = f.file_id
      WHERE s.embedding IS NOT NULL
    `).all() as any[];

    const results: [number, SearchResult][] = [];
    for (const row of rows) {
      const storedEmb = DatabaseManager.blobToFloats(row.embedding);
      if (!storedEmb || storedEmb.length === 0) continue;

      const score = DatabaseManager.cosineSimilarity(queryEmbedding, storedEmb);
      results.push([score, {
        nodeKey: row.node_key,
        fileId: row.file_id,
        filePath: row.file_id,
        headingPath: row.heading_path || "",
        headingText: row.heading_text || "",
        lineStart: row.line_start || 0,
        lineEnd: row.line_end || 0,
        text: row.text || "",
        contentHash: row.content_hash || "",
        fileContentHash: row.content_hash || "",
        contentType: row.content_type || "",
        rollupSummary: row.rollup_summary || "",
        title: row.title || "",
        score,
      }]);
    }

    results.sort((a, b) => b[0] - a[0]);
    return results.slice(0, topK).map(r => r[1]);
  }

  // ------------------------------------------------------------------
  // Entity operations
  // ------------------------------------------------------------------

  insertEntities(entities: Array<{ entityId: string; name: string; type?: string }>): void {
    const conn = this.connect();
    const stmt = conn.prepare(
      "INSERT OR IGNORE INTO ENTITIES (entity_id, name, type) VALUES (?, ?, ?)"
    );
    for (const ent of entities) {
      stmt.run(ent.entityId, ent.name, ent.type || "unknown");
    }
  }

  insertSectionEntities(sectionKey: string, entities: Array<{ entityId: string }>): void {
    const conn = this.connect();
    const stmt = conn.prepare(
      "INSERT OR IGNORE INTO SECTION_ENTITIES (section_key, entity_id) VALUES (?, ?)"
    );
    for (const ent of entities) {
      stmt.run(sectionKey, ent.entityId);
    }
  }

  // ------------------------------------------------------------------
  // Edge operations
  // ------------------------------------------------------------------

  insertEdges(edges: Edge[]): void {
    const conn = this.connect();
    const stmt = conn.prepare(
      "INSERT OR REPLACE INTO EDGES (src_key, dst_key, kind, weight) VALUES (?, ?, ?, ?)"
    );
    for (const edge of edges) {
      stmt.run(edge.srcKey, edge.dstKey, edge.kind, edge.weight);
    }
  }

  getWikilinkEdges(fileId: string): Edge[] {
    const conn = this.connect();
    return conn.prepare(
      `SELECT src_key, dst_key, kind, weight FROM EDGES
       WHERE kind IN ('wikilink', 'backlink') AND (src_key = ? OR src_key LIKE ?)`
    ).all(fileId, `${fileId}::%`) as Edge[];
  }

  deleteEdgesForFile(fileId: string): void {
    const conn = this.connect();
    conn.prepare(
      "DELETE FROM EDGES WHERE src_key = ? OR src_key LIKE ? OR dst_key = ? OR dst_key LIKE ?"
    ).run(fileId, `${fileId}::%`, fileId, `${fileId}::%`);
  }

  getUnlinkedSections(): Record<string, any>[] {
    const conn = this.connect();
    const rows = conn.prepare(`
      SELECT s.node_key, s.file_id, s.embedding
      FROM SECTIONS s
      WHERE s.node_key NOT IN (
        SELECT src_key FROM EDGES WHERE kind IN ('wikilink', 'backlink')
        UNION
        SELECT dst_key FROM EDGES WHERE kind IN ('wikilink', 'backlink')
      )
    `).all() as any[];
    return rows.map((r: any) => ({
      nodeKey: r.node_key,
      fileId: r.file_id,
      embedding: DatabaseManager.blobToFloats(r.embedding),
    }));
  }

  // ------------------------------------------------------------------
  // Community operations
  // ------------------------------------------------------------------

  insertCommunity(community: Record<string, any>): string {
    const conn = this.connect();
    conn.prepare(
      "INSERT OR REPLACE INTO COMMUNITIES (community_id, seed_source, label) VALUES (?, ?, ?)"
    ).run(community.communityId || community.community_id, community.seedSource || community.seed_source || "unsupervised", community.label || "");
    return community.communityId || community.community_id;
  }

  getAllCommunities(): Record<string, any>[] {
    const conn = this.connect();
    return conn.prepare("SELECT * FROM COMMUNITIES ORDER BY community_id").all() as any[];
  }

  assignSectionToCommunity(sectionKey: string, communityId: string): void {
    const conn = this.connect();
    conn.prepare(
      "INSERT OR IGNORE INTO COMMUNITY_SECTIONS (section_key, community_id) VALUES (?, ?)"
    ).run(sectionKey, communityId);
  }

  getCommunityForSection(sectionKey: string): string | null {
    const conn = this.connect();
    const row = conn.prepare(
      "SELECT community_id FROM COMMUNITY_SECTIONS WHERE section_key = ?"
    ).get(sectionKey) as any;
    return row ? row.community_id : null;
  }

  clearCommunityAssignments(): void {
    const conn = this.connect();
    conn.prepare("DELETE FROM COMMUNITY_SECTIONS").run();
  }

  // ------------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------------

  insertMeta(vaultVersion: string, manifestHash: string = ""): number {
    const conn = this.connect();
    const now = new Date().toISOString();
    const result = conn.prepare(
      "INSERT INTO INDEX_META (built_at, vault_version, manifest_hash) VALUES (?, ?, ?)"
    ).run(now, vaultVersion, manifestHash);
    return Number(result.lastInsertRowid);
  }

  getLatestMeta(): Record<string, any> | null {
    const conn = this.connect();
    return conn.prepare(
      "SELECT * FROM INDEX_META ORDER BY snapshot_id DESC LIMIT 1"
    ).get() as any || null;
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
  // Static helpers
  // ------------------------------------------------------------------

  static blobToFloats(blob: Buffer | null): number[] | null {
    if (!blob || blob.length === 0) return null;
    const count = blob.length / 8;
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      result.push(blob.readDoubleLE(i * 8));
    }
    return result;
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0.0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Edge {
  srcKey: string;
  dstKey: string;
  kind: string;
  weight: number;
}

export interface SearchResult {
  nodeKey: string;
  fileId: string;
  filePath: string;
  headingPath: string;
  headingText: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  contentHash: string;
  fileContentHash: string;
  contentType: string;
  rollupSummary: string;
  title: string;
  score: number;
}
