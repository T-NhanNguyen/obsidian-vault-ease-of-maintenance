// Integration tests for the sql.js schema and the legacy-index upgrade path.
// Ported from tests/integration/test_schema.py (better-sqlite3 era).
//
// Two layers are pinned:
//   1. The sync engine (SqlJsDatabase) — schema, columns, meta, v1-table
//      retirement, mid-v2 column repair, user_version marker.
//   2. The facade upgrade path (DatabaseManager) — a legacy file (WAL
//      sidecar, unparseable, or user_version < 2) is retired to legacy/ and
//      a fresh v2 index is created; searches and writes then work normally.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { DatabaseManager } from "../../src/indexer/db";
import { DB_ENGINE_VERSION, SqlJsDatabase } from "../../src/indexer/db_worker/sqljs_database";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function openRaw(dbPath: string) {
  return new SQL.Database(fs.readFileSync(dbPath));
}

function tableNames(dbPath: string): Set<string> {
  const conn = openRaw(dbPath);
  try {
    const rows = conn.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? [];
    return new Set(rows.map((r) => String(r[0])));
  } finally {
    conn.close();
  }
}

function columns(dbPath: string, table: string): Set<string> {
  const conn = openRaw(dbPath);
  try {
    const rows = conn.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
    return new Set(rows.map((r) => String(r[1])));
  } finally {
    conn.close();
  }
}

function userVersion(dbPath: string): number {
  const conn = openRaw(dbPath);
  try {
    const value = conn.exec("PRAGMA user_version")[0]?.values[0]?.[0];
    return typeof value === "number" ? value : 0;
  } finally {
    conn.close();
  }
}

function writeLegacyFile(tmpDir: string, filename: string, create: (conn: Database) => void): string {
  // Uses the sql.js API directly to fabricate a legacy-format file: the
  // schema is whatever the caller writes; user_version stays 0 (as the old
  // better-sqlite3 engine left it).
  const dbPath = path.join(tmpDir, filename);
  const conn = new SQL.Database();
  create(conn);
  fs.writeFileSync(dbPath, conn.export());
  conn.close();
  return dbPath;
}

const V2_TABLES = new Set([
  "FILES", "SECTIONS", "ENTITIES", "SECTION_ENTITIES",
  "EDGES", "COMMUNITIES", "INDEX_META",
]);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "test-schema-"));
}

describe("Schema", () => {
  it("tables exist after initialize", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    const tables = tableNames(dbPath);
    for (const t of V2_TABLES) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("sections columns", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    const cols = columns(dbPath, "SECTIONS");
    expect(cols.has("node_key")).toBe(true);
    expect(cols.has("file_id")).toBe(true);
    expect(cols.has("heading_path")).toBe(true);
    expect(cols.has("embedding")).toBe(true);
  });

  it("edges columns", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    const cols = columns(dbPath, "EDGES");
    expect(cols.has("src_key")).toBe(true);
    expect(cols.has("dst_key")).toBe(true);
    expect(cols.has("kind")).toBe(true);
    expect(cols.has("weight")).toBe(true);
  });

  it("index meta columns", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    const cols = columns(dbPath, "INDEX_META");
    expect(cols.has("vault_version")).toBe(true);
    expect(cols.has("manifest_hash")).toBe(true);
  });

  it("writes the engine version marker", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    expect(userVersion(dbPath)).toBe(DB_ENGINE_VERSION);
  });
});

describe("Meta", () => {
  it("insert and get meta", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.insertMeta("vault:7files", "abc123");
    const meta = await db.getLatestMeta();
    await db.close();

    expect(meta).not.toBeNull();
    expect(meta!.vault_version).toBe("vault:7files");
    expect(meta!.manifest_hash).toBe("abc123");
  });
});

describe("SqlJsDatabase (sync engine)", () => {
  it("drops v1 chunks tables and creates the v2 schema in place", async () => {
    const dir = tmpDir();
    const dbPath = writeLegacyFile(dir, "v1.db", (conn) => {
      conn.run("CREATE TABLE CHUNKS (id INTEGER PRIMARY KEY)");
      conn.run("CREATE TABLE CHUNK_ENTITIES (id INTEGER PRIMARY KEY)");
      conn.run("CREATE TABLE FILES (path TEXT PRIMARY KEY)");
      // A file that reached the current engine already carries the marker.
      conn.run(`PRAGMA user_version = ${DB_ENGINE_VERSION}`);
    });

    const engine = SqlJsDatabase.create(SQL, fs.readFileSync(dbPath));
    expect(engine).not.toBeNull();
    const db = engine!;
    db.initialize();
    const bytes = db.export();
    db.close();
    fs.writeFileSync(dbPath, bytes);

    const tables = tableNames(dbPath);
    expect(tables.has("CHUNKS")).toBe(false);
    expect(tables.has("CHUNK_ENTITIES")).toBe(false);
    for (const t of V2_TABLES) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("repairs mid-v2 column drift", async () => {
    const dir = tmpDir();
    const dbPath = writeLegacyFile(dir, "drift.db", (conn) => {
      conn.run("CREATE TABLE FILES (file_id TEXT PRIMARY KEY, path TEXT, title TEXT)");
      conn.run("CREATE TABLE INDEX_META (id INTEGER)");
      conn.run("PRAGMA user_version = 2");
    });

    const engine = SqlJsDatabase.create(SQL, fs.readFileSync(dbPath));
    expect(engine).not.toBeNull();
    const db = engine!;
    db.initialize();
    const bytes = db.export();
    db.close();
    fs.writeFileSync(dbPath, bytes);

    const cols = columns(dbPath, "FILES");
    expect(cols.has("content_type")).toBe(true);
    expect(cols.has("rollup_summary")).toBe(true);
  });
});

describe("Legacy index upgrade (facade)", () => {
  it("retires a v1 file to legacy/ and creates a fresh v2 index", async () => {
    const dir = tmpDir();
    const dbPath = writeLegacyFile(dir, "index.db", (conn) => {
      conn.run("CREATE TABLE CHUNKS (id INTEGER PRIMARY KEY)");
      conn.run("CREATE TABLE FILES (path TEXT PRIMARY KEY)");
    });

    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    // The legacy file was moved aside and a fresh v2 index was created.
    const legacyDir = path.join(dir, "legacy");
    expect(fs.existsSync(path.join(legacyDir, "index.db"))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    for (const t of V2_TABLES) {
      expect(tableNames(dbPath).has(t)).toBe(true);
    }
    expect(tableNames(dbPath).has("CHUNKS")).toBe(false);
  });

  it("retires a legacy v2 file with user_version 0", async () => {
    const dir = tmpDir();
    const dbPath = writeLegacyFile(dir, "index.db", (conn) => {
      conn.run("CREATE TABLE FILES (file_id TEXT PRIMARY KEY, path TEXT, title TEXT)");
    });

    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    expect(fs.existsSync(path.join(dir, "legacy", "index.db"))).toBe(true);
    expect(userVersion(dbPath)).toBe(DB_ENGINE_VERSION);
  });

  it("retires the index when a -wal sidecar exists next to it", async () => {
    const dir = tmpDir();
    const dbPath = writeLegacyFile(dir, "index.db", (conn) => {
      conn.run("CREATE TABLE FILES (file_id TEXT PRIMARY KEY, path TEXT)");
    });
    // A WAL sidecar may hold uncheckpointed frames sql.js silently ignores.
    fs.writeFileSync(path.join(dir, "index.db-wal"), Buffer.from("wal frames"));

    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    expect(fs.existsSync(path.join(dir, "legacy", "index.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "legacy", "index.db-wal"))).toBe(true);
  });

  it("retires an unparseable file and keeps the plugin usable", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    fs.writeFileSync(dbPath, Buffer.from("this is not a sqlite database at all"));

    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();

    expect(fs.existsSync(path.join(dir, "legacy", "index.db"))).toBe(true);
    expect(tableNames(dbPath).has("FILES")).toBe(true);
  });

  it("does not re-trigger the upgrade on a current-engine file", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "index.db");
    const db = new DatabaseManager(dbPath);
    await db.initialize();
    await db.close();
    // Second open is a no-op upgrade-wise.
    const db2 = new DatabaseManager(dbPath);
    await db2.initialize();
    await db2.close();

    expect(fs.existsSync(path.join(dir, "legacy"))).toBe(false);
  });
});
