// Regression tests for the live-Obsidian bug (handoff 2026-08-15): one
// "Build GraphRAG index" command looped ~108 nested runBuild calls through
// the upgrade hook, then OOM'd the renderer (`cannot allocate wasm memory`).
//
// Root cause: Obsidian's DataAdapter.list() returns vault-relative FULL PATHS
// (e.g. ".note-maintainer/index.db-wal"), while the facade matched bare names
// ("index.db-…"). The legacy retire moved nothing, so every nested open
// re-detected the legacy file and re-fired the hook — each level holding a
// live sql.js worker (nested, so none freed) until wasm memory ran out.
//
// These tests pin the three fixes:
//   1. Bare-name normalization for adapter-listed entries (db_host.ts).
//   2. Retire verifies files actually moved before firing the hook (db.ts).
//   3. A hard reentrancy guard on the upgrade flow (db.ts).

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as path from "path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { DatabaseManager } from "../../src/indexer/db";
import { updateSettings } from "../../src/config";
import { DB_ENGINE_VERSION } from "../../src/indexer/db_worker/sqljs_database";
import { createObsidianDbHost } from "../../src/indexer/db_host";
import type { DbChannel, DbFileIO, DbHost } from "../../src/indexer/db_host";
import type { DbMethodMap, DbMethodName } from "../../src/indexer/db_worker/protocol";
import { DbWorkerCore } from "../../src/indexer/db_worker/worker_core";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

// ---------------------------------------------------------------------------
// Test host: in-memory IO that can reproduce the Obsidian adapter's
// full-path listFiles shape
// ---------------------------------------------------------------------------

type ListShape = "bare" | "full";

class MemIO implements DbFileIO {
  readonly files = new Map<string, Uint8Array>();
  shape: ListShape = "full"; // default: Obsidian DataAdapter.list() shape
  readonly renameFailures = new Set<string>();

  async exists(absPath: string): Promise<boolean> {
    return this.files.has(absPath);
  }

  async readBinary(absPath: string): Promise<Uint8Array> {
    const bytes = this.files.get(absPath);
    if (!bytes) throw new Error(`ENOENT: ${absPath}`);
    return bytes;
  }

  async writeBinaryAtomic(absPath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(absPath, bytes);
  }

  async mkdirp(_absPath: string): Promise<void> {}

  async rename(fromAbs: string, toAbs: string): Promise<void> {
    if (this.renameFailures.has(fromAbs)) {
      throw new Error(`simulated rename failure: ${fromAbs}`);
    }
    const bytes = this.files.get(fromAbs);
    if (!bytes) throw new Error(`ENOENT rename: ${fromAbs}`);
    this.files.delete(fromAbs);
    this.files.set(toAbs, bytes);
  }

  async listFiles(absDir: string): Promise<string[]> {
    const prefix = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
    const entries = [...this.files.keys()].filter(
      (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes(path.sep),
    );
    return this.shape === "full" ? entries : entries.map((f) => path.basename(f));
  }
}

class CoreChannel implements DbChannel {
  private readonly core = new DbWorkerCore(null);

  async open(dbBytes: Uint8Array | null): Promise<{ needsRebuild: boolean }> {
    return this.core.open(dbBytes);
  }

  async call<K extends DbMethodName>(
    method: K,
    ...args: DbMethodMap[K]["args"]
  ): Promise<DbMethodMap[K]["result"]> {
    return this.core.call(method, args) as DbMethodMap[K]["result"];
  }

  async close(): Promise<Uint8Array | null> {
    return this.core.close();
  }

  dispose(): void {
    this.core.dispose();
  }
}

function inMemoryHost(io: MemIO, hook?: () => void | Promise<void>): DbHost {
  return {
    io,
    loadWasmBinary: async () => null,
    createChannel: async () => new CoreChannel(),
    onIndexUpgraded: hook,
  };
}

function legacyIndexBytes(create: (conn: Database) => void): Uint8Array {
  const conn = new SQL.Database();
  create(conn);
  const bytes = conn.export();
  conn.close();
  return bytes;
}

function readUserVersion(bytes: Uint8Array): number {
  const conn = new SQL.Database(bytes);
  try {
    const value = conn.exec("PRAGMA user_version")[0]?.values[0]?.[0];
    return typeof value === "number" ? value : 0;
  } finally {
    conn.close();
  }
}

const V1_INDEX = (conn: Database): void => {
  conn.run("CREATE TABLE CHUNKS (id INTEGER PRIMARY KEY)");
  conn.run("CREATE TABLE FILES (path TEXT PRIMARY KEY)");
};

// ---------------------------------------------------------------------------
// Obsidian host adapter-shape fixes
// ---------------------------------------------------------------------------

describe("Obsidian DbHost adapter shape", () => {
  it("normalizes full vault-relative paths to bare names in listFiles", async () => {
    const adapter = {
      list: async () => ({
        files: [".note-maintainer/index.db", ".note-maintainer/index.db-wal"],
        folders: [],
      }),
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    const host = createObsidianDbHost(adapter, "/vault");

    const names = await host.io.listFiles("/vault/.note-maintainer");
    expect(names.sort()).toEqual(["index.db", "index.db-wal"]);
  });

  it("mkdirp swallows only already-exists errors and surfaces real ones", async () => {
    const mkdirCalls: string[] = [];
    const existingAdapter = {
      mkdir: async (p: string) => {
        mkdirCalls.push(p);
        if (p === "a/b") throw new Error("Folder already exists: a/b");
      },
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    const host = createObsidianDbHost(existingAdapter, "/vault");

    await host.io.mkdirp("/vault/a/b/c");
    expect(mkdirCalls).toEqual(["a", "a/b", "a/b/c"]);

    const failingAdapter = {
      mkdir: async () => {
        throw new Error("disk full");
      },
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    const failingHost = createObsidianDbHost(failingAdapter, "/vault");
    await expect(failingHost.io.mkdirp("/vault/x/y")).rejects.toThrow("disk full");
  });
});

// ---------------------------------------------------------------------------
// Legacy-index upgrade under the Obsidian full-path listFiles shape
// ---------------------------------------------------------------------------

describe("Legacy index upgrade (Obsidian full-path shape)", () => {
  it("retires a v1 index, fires the hook exactly once, and writes a fresh v2 index", async () => {
    const dir = "/vault/.note-maintainer";
    const dbPath = path.join(dir, "index.db");
    const io = new MemIO();
    io.shape = "full";
    io.files.set(dbPath, legacyIndexBytes(V1_INDEX));

    let hookCalls = 0;
    const db = new DatabaseManager(dbPath, inMemoryHost(io, () => { hookCalls++; }));
    await db.initialize();
    await db.close();

    expect(hookCalls).toBe(1); // exactly one upgrade event — no recursion
    expect(db.didUpgrade).toBe(true);
    expect(io.files.has(path.join(dir, "legacy", "index.db"))).toBe(true);
    expect(io.files.has(dbPath)).toBe(true); // fresh index written back
    expect(readUserVersion(io.files.get(dbPath)!)).toBe(DB_ENGINE_VERSION);
  });

  it("retires the index AND its WAL sidecar in one upgrade", async () => {
    const dir = "/vault/.note-maintainer";
    const dbPath = path.join(dir, "index.db");
    const io = new MemIO();
    io.shape = "full";
    io.files.set(dbPath, legacyIndexBytes(V1_INDEX));
    io.files.set(`${dbPath}-wal`, new Uint8Array([1, 2, 3]));

    let hookCalls = 0;
    const db = new DatabaseManager(dbPath, inMemoryHost(io, () => { hookCalls++; }));
    await db.initialize();
    await db.close();

    expect(hookCalls).toBe(1);
    expect(db.didUpgrade).toBe(true);
    expect(io.files.has(path.join(dir, "legacy", "index.db"))).toBe(true);
    expect(io.files.has(path.join(dir, "legacy", "index.db-wal"))).toBe(true);
  });

  it("does not fire the upgrade hook on a current-engine index", async () => {
    const dir = "/vault/.note-maintainer";
    const dbPath = path.join(dir, "index.db");
    const io = new MemIO();
    io.shape = "full";

    let hookCalls = 0;
    const host = inMemoryHost(io, () => { hookCalls++; });
    const first = new DatabaseManager(dbPath, host);
    await first.initialize();
    await first.close();

    const second = new DatabaseManager(dbPath, host);
    await second.initialize();
    await second.close();

    expect(hookCalls).toBe(0);
    expect(second.didUpgrade).toBe(false);
    expect(io.files.has(path.join(dir, "legacy"))).toBe(false);
  });

  it("a failed retire move fires no hook and self-heals with a fresh index", async () => {
    const dir = "/vault/.note-maintainer";
    const dbPath = path.join(dir, "index.db");
    const io = new MemIO();
    io.shape = "full";
    io.files.set(dbPath, legacyIndexBytes(V1_INDEX));
    io.renameFailures.add(dbPath); // adapter rename fails

    let hookCalls = 0;
    const db = new DatabaseManager(dbPath, inMemoryHost(io, () => { hookCalls++; }));
    await db.initialize(); // must not throw
    await db.close();

    expect(hookCalls).toBe(0); // nothing moved → no hook → no recursion
    expect(db.didUpgrade).toBe(false);
    expect(io.files.has(dbPath)).toBe(true);
    expect(readUserVersion(io.files.get(dbPath)!)).toBe(DB_ENGINE_VERSION); // self-healed
  });
});

// ---------------------------------------------------------------------------
// Reentrancy guard
// ---------------------------------------------------------------------------

describe("Upgrade reentrancy guard", () => {
  it("suppresses a nested upgrade opened by the hook", async () => {
    const dir = "/vault/.note-maintainer";
    const dbPath = path.join(dir, "index.db");
    const otherPath = path.join(dir, "index2.db");
    const io = new MemIO();
    io.shape = "full";
    io.files.set(dbPath, legacyIndexBytes(V1_INDEX));
    io.files.set(otherPath, legacyIndexBytes(V1_INDEX));

    let hookCalls = 0;
    // Old-style reentrant hook: fires a nested DB open on ANOTHER legacy
    // file while this upgrade is still in flight.
    const host = inMemoryHost(io, async () => {
      hookCalls++;
      const nested = new DatabaseManager(otherPath, host);
      await nested.initialize();
      await nested.close();
    });

    const db = new DatabaseManager(dbPath, host);
    await db.initialize();
    await db.close();

    expect(hookCalls).toBe(1); // nested upgrade suppressed by the guard
    expect(db.didUpgrade).toBe(true);
    expect(io.files.has(path.join(dir, "legacy", "index.db"))).toBe(true);
    // The nested open fell back to a fresh index — it never looped and never
    // re-fired the hook.
    expect(readUserVersion(io.files.get(otherPath)!)).toBe(DB_ENGINE_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Wasm asset loading (loadWasmBinary) — regression for the live-Obsidian
// "OUT_OF_SCOPE: DB path outside the vault: .obsidian/plugins" build failure:
// configDir/pluginDir are vault-RELATIVE and must never be routed through
// rel() (which requires absolute paths).
// ---------------------------------------------------------------------------

describe("Obsidian DbHost wasm loading", () => {
  const wasmBytes = new Uint8Array([1, 2, 3, 4]);

  afterEach(() => {
    updateSettings({ configDir: "", pluginDir: "" });
  });

  it("uses the plugin's own dir first and never runs the plugin scan", async () => {
    let listCalls = 0;
    const adapter = {
      readBinary: async (p: string) => {
        expect(p).toBe(".obsidian/plugins/my-plugin/sql-wasm.wasm");
        return wasmBytes.buffer as ArrayBuffer;
      },
      list: async () => {
        listCalls++;
        return { files: [], folders: [] };
      },
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    updateSettings({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/my-plugin" });

    const host = createObsidianDbHost(adapter, "/vault");
    const wasm = await host.loadWasmBinary();
    expect(wasm).toEqual(wasmBytes);
    expect(listCalls).toBe(0);
  });

  it("scans every plugin folder when manifest.dir is empty (no OUT_OF_SCOPE)", async () => {
    const adapter = {
      readBinary: async (p: string) => {
        // Vault-relative full path — never routed through rel().
        expect(p).toBe(".obsidian/plugins/other-plugin/sql-wasm.wasm");
        return wasmBytes.buffer as ArrayBuffer;
      },
      list: async (p: string) => {
        expect(p).toBe(".obsidian/plugins");
        return {
          files: [],
          folders: [".obsidian/plugins/my-plugin", ".obsidian/plugins/other-plugin"],
        };
      },
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    updateSettings({ configDir: ".obsidian", pluginDir: "" });

    const host = createObsidianDbHost(adapter, "/vault");
    const wasm = await host.loadWasmBinary();
    expect(wasm).toEqual(wasmBytes);
  });

  it("throws a clear not-found error (not OUT_OF_SCOPE) when no plugin has the wasm", async () => {
    const adapter = {
      readBinary: async () => {
        throw new Error("ENOENT");
      },
      list: async () => ({
        files: [],
        folders: [".obsidian/plugins/my-plugin"],
      }),
    } as unknown as Parameters<typeof createObsidianDbHost>[0];
    updateSettings({ configDir: ".obsidian", pluginDir: "" });

    const host = createObsidianDbHost(adapter, "/vault");
    await expect(host.loadWasmBinary()).rejects.toThrow("sql.js wasm asset");
  });
});
