// Integration tests for the SQLite schema and migrations.
// Ported from tests/integration/test_schema.py

import { describe, it, expect } from "vitest";
import { DatabaseManager } from "../../src/indexer/db";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import Database from "better-sqlite3";

function tableNames(dbPath: string): Set<string> {
  const conn = new Database(dbPath);
  try {
    const rows = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    return new Set(rows.map((r: any) => r.name));
  } finally {
    conn.close();
  }
}

function columns(dbPath: string, table: string): Set<string> {
  const conn = new Database(dbPath);
  try {
    const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return new Set(rows.map((r: any) => r.name));
  } finally {
    conn.close();
  }
}

const V2_TABLES = new Set([
  "FILES", "SECTIONS", "ENTITIES", "SECTION_ENTITIES",
  "EDGES", "COMMUNITIES", "INDEX_META",
]);

describe("Schema", () => {
  it("tables exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-schema-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();

    const tables = tableNames(dbPath);
    for (const t of V2_TABLES) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("sections columns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-schema-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();

    const cols = columns(dbPath, "SECTIONS");
    expect(cols.has("node_key")).toBe(true);
    expect(cols.has("file_id")).toBe(true);
    expect(cols.has("heading_path")).toBe(true);
    expect(cols.has("embedding")).toBe(true);
  });

  it("edges columns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-schema-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();

    const cols = columns(dbPath, "EDGES");
    expect(cols.has("src_key")).toBe(true);
    expect(cols.has("dst_key")).toBe(true);
    expect(cols.has("kind")).toBe(true);
    expect(cols.has("weight")).toBe(true);
  });

  it("index meta columns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-schema-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();

    const cols = columns(dbPath, "INDEX_META");
    expect(cols.has("vault_version")).toBe(true);
    expect(cols.has("manifest_hash")).toBe(true);
  });
});

describe("Meta", () => {
  it("insert and get meta", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-meta-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();
    db.insertMeta("vault:7files", "abc123");
    const meta = db.getLatestMeta();
    expect(meta).not.toBeNull();
    expect(meta!.vault_version).toBe("vault:7files");
    expect(meta!.manifest_hash).toBe("abc123");
  });
});

describe("Migration", () => {
  it("v1 chunks table dropped", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-migration-"));
    const dbPath = path.join(tmpDir, "v1.db");

    const conn = new Database(dbPath);
    conn.prepare("CREATE TABLE CHUNKS (id INTEGER PRIMARY KEY)").run();
    conn.prepare("CREATE TABLE CHUNK_ENTITIES (id INTEGER PRIMARY KEY)").run();
    conn.prepare("CREATE TABLE FILES (path TEXT PRIMARY KEY)").run();
    conn.close();

    const db = new DatabaseManager(dbPath);
    db.initialize();

    const tables = tableNames(dbPath);
    expect(tables.has("CHUNKS")).toBe(false);
    expect(tables.has("CHUNK_ENTITIES")).toBe(false);
    for (const t of V2_TABLES) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("v2 database untouched", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-migration-"));
    const dbPath = path.join(tmpDir, "index.db");
    const db = new DatabaseManager(dbPath);
    db.initialize();
    const tables = tableNames(dbPath);
    for (const t of V2_TABLES) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("v1 files only db migrates", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-migration-"));
    const dbPath = path.join(tmpDir, "v1files.db");

    const conn = new Database(dbPath);
    conn.prepare("CREATE TABLE FILES (path TEXT PRIMARY KEY, title TEXT)").run();
    conn.prepare("CREATE TABLE EDGES (src TEXT, dst TEXT)").run();
    conn.prepare("CREATE TABLE INDEX_META (id INTEGER)").run();
    conn.close();

    const db = new DatabaseManager(dbPath);
    db.initialize();

    for (const t of V2_TABLES) {
      expect(tableNames(dbPath).has(t)).toBe(true);
    }

    const cols = columns(dbPath, "FILES");
    expect(cols.has("file_id")).toBe(true);
    expect(cols.has("content_type")).toBe(true);
    expect(cols.has("rollup_summary")).toBe(true);
  });

  it("mid v2 column drift is repaired", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-migration-"));
    const dbPath = path.join(tmpDir, "drift.db");

    const conn = new Database(dbPath);
    conn.prepare("CREATE TABLE FILES (file_id TEXT PRIMARY KEY, path TEXT, title TEXT)").run();
    conn.prepare("CREATE TABLE INDEX_META (id INTEGER)").run();
    conn.close();

    const db = new DatabaseManager(dbPath);
    db.initialize();

    const cols = columns(dbPath, "FILES");
    expect(cols.has("content_type")).toBe(true);
    expect(cols.has("rollup_summary")).toBe(true);
  });
});
