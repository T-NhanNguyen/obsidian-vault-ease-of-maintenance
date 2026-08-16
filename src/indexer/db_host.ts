// Main-thread DB host — the interface between the async DatabaseManager
// facade and the disposable sql.js worker.
//
// Two concrete hosts:
//   - createObsidianDbHost(adapter): the production path. All vault-file I/O
//     goes through app.vault.adapter (the vault API — this is what removes
//     the store-review "Direct Filesystem Access" trigger that better-sqlite3
//     caused). The worker is a real Web Worker spawned from the embedded
//     WORKER_BUNDLE string via a Blob URL. The sql.js wasm is EMBEDDED in
//     the main bundle (base64, see embedded_wasm.ts) — no disk read, which
//     is what makes store installs work (the store ships only main.js /
//     manifest.json / styles.css).
//   - createNodeDbHost(): the test/plain-Node path. File I/O goes through
//     VaultIO (the fs chokepoint) and the "worker" is an in-process
//     DbWorkerCore — sql.js is loaded from node_modules at first use.
//
// The worker receives BYTES, never paths. The database stays a vault file:
// the main thread reads settings.dbPath into memory, transfers it to the
// worker (zero-copy), and writes the exported bytes back when the execution
// modified the index.

import * as path from "path";
import type { DataAdapter } from "obsidian";
import { WORKER_BUNDLE } from "@worker-bundle";
import { errorMessage } from "../errors";
import { getEmbeddedWasmBinary } from "./embedded_wasm";
import { VaultIO } from "../io/vault_io";
import type { DbMethodMap, DbMethodName, WorkerRequest, WorkerResponse } from "./db_worker/protocol";
import { DbWorkerCore } from "./db_worker/worker_core";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Vault-file I/O keyed by ABSOLUTE paths (the facade deals in dbPath). */
export interface DbFileIO {
  exists(absPath: string): Promise<boolean>;
  readBinary(absPath: string): Promise<Uint8Array>;
  writeBinaryAtomic(absPath: string, bytes: Uint8Array): Promise<void>;
  mkdirp(absPath: string): Promise<void>;
  rename(fromAbs: string, toAbs: string): Promise<void>;
  /** Bare file names in the directory (never prefixed paths). */
  listFiles(absDir: string): Promise<string[]>;
}

/** One disposable worker execution: open → ops → close. */
export interface DbChannel {
  open(dbBytes: Uint8Array | null): Promise<{ needsRebuild: boolean }>;
  call<K extends DbMethodName>(method: K, ...args: DbMethodMap[K]["args"]): Promise<DbMethodMap[K]["result"]>;
  /** Finalize: returns exported bytes when the DB changed, else null. */
  close(): Promise<Uint8Array | null>;
  /** Hard teardown without exporting (error paths). */
  dispose(): void;
}

export interface DbHost {
  io: DbFileIO;
  /** sql.js wasm bytes; null lets sql.js auto-locate (Node/tests). */
  loadWasmBinary(): Promise<Uint8Array | null>;
  createChannel(wasmBinary: Uint8Array | null): Promise<DbChannel>;
  /** Fired once when a legacy index is retired to .note-maintainer/legacy/. */
  onIndexUpgraded?(): void | Promise<void>;
}

export interface ObsidianDbHostHooks {
  onIndexUpgraded?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Browser channel — real Web Worker from the embedded bundle string
// ---------------------------------------------------------------------------

const OPEN_TOKEN = "__open__";
const CLOSE_TOKEN = "__close__";

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class BrowserDbChannel implements DbChannel {
  private readonly worker: Worker;
  private readonly objectUrl: string;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly wasmBinary: Uint8Array | null;
  private nextId = 0;
  private disposed = false;

  constructor(wasmBinary: Uint8Array | null) {
    this.wasmBinary = wasmBinary;
    this.objectUrl = URL.createObjectURL(
      new Blob([WORKER_BUNDLE], { type: "application/javascript" }),
    );
    this.worker = new Worker(this.objectUrl);
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event: ErrorEvent): void => {
      this.failAll(new Error(`sql.js worker error: ${event.message}`));
    };
  }

  async open(dbBytes: Uint8Array | null): Promise<{ needsRebuild: boolean }> {
    const message: WorkerRequest = { kind: "open", wasmBinary: this.wasmBinary, dbBytes };
    const transfer = this.transferList(dbBytes);
    const response = (await this.post(message, OPEN_TOKEN, transfer)) as WorkerResponse;
    if (response.kind !== "open-result") {
      throw new Error("sql.js worker: unexpected open response");
    }
    return { needsRebuild: response.needsRebuild };
  }

  async call<K extends DbMethodName>(
    method: K,
    ...args: DbMethodMap[K]["args"]
  ): Promise<DbMethodMap[K]["result"]> {
    const id = ++this.nextId;
    const token = String(id);
    const message: WorkerRequest = { kind: "op", id, method, args };
    const response = (await this.post(message, token, [])) as WorkerResponse;
    if (response.kind !== "op-result") {
      throw new Error("sql.js worker: unexpected op response");
    }
    if (!response.ok) {
      throw new Error(response.error || `sql.js worker op failed: ${method}`);
    }
    return response.value as DbMethodMap[K]["result"];
  }

  async close(): Promise<Uint8Array | null> {
    const message: WorkerRequest = { kind: "close" };
    const response = (await this.post(message, CLOSE_TOKEN, [])) as WorkerResponse;
    this.dispose();
    if (response.kind !== "close-result" || !response.ok) {
      throw new Error(response.kind === "close-result" ? (response.error || "close failed") : "sql.js worker: unexpected close response");
    }
    return response.bytes ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("sql.js worker disposed"));
    this.worker.terminate();
    URL.revokeObjectURL(this.objectUrl);
  }

  private post(message: WorkerRequest, token: string, transfer: Transferable[]): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("sql.js worker already disposed"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(token, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  private handleResponse(response: WorkerResponse): void {
    let token: string;
    if (response.kind === "open-result") token = OPEN_TOKEN;
    else if (response.kind === "close-result") token = CLOSE_TOKEN;
    else token = String(response.id);
    const entry = this.pending.get(token);
    if (!entry) return;
    this.pending.delete(token);
    entry.resolve(response);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  private transferList(bytes: Uint8Array | null): Transferable[] {
    return bytes ? [bytes.buffer as Transferable] : [];
  }
}

// ---------------------------------------------------------------------------
// In-process channel — Node tests / plain Node (no real worker thread)
// ---------------------------------------------------------------------------

class InProcessDbChannel implements DbChannel {
  private readonly core: DbWorkerCore;

  constructor(wasmBinary: Uint8Array | null) {
    this.core = new DbWorkerCore(wasmBinary);
  }

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

// Obsidian's DataAdapter.list() returns vault-relative FULL PATHS (e.g.
// ".note-maintainer/index.db-wal"), not bare names. Normalizing here means
// the facade's bare-name matching (WAL sidecar, legacy retire) works
// regardless of what a concrete host returns.
function toBareName(entry: string): string {
  return path.posix.basename(entry);
}

// adapter.mkdir throws "Folder already exists: …" (Obsidian) or an EEXIST
// fs error for an existing directory. mkdirp swallows exactly that; any
// other failure is a real problem and must surface (a silently-missing
// legacy/ used to make the legacy retire move nothing and loop forever).
function isAlreadyExistsError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("already exists") || message.includes("eexist") || message.includes("file exists");
}

// ---------------------------------------------------------------------------
// Obsidian host (vault API adapter I/O + browser worker)
// ---------------------------------------------------------------------------

export function createObsidianDbHost(
  adapter: DataAdapter,
  vaultPath: string,
  hooks: ObsidianDbHostHooks = {},
): DbHost {
  const rel = (absPath: string): string => {
    const relative = path.relative(vaultPath, absPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`OUT_OF_SCOPE: DB path outside the vault: ${absPath}`);
    }
    return relative.split(path.sep).join("/");
  };

  const io: DbFileIO = {
    async exists(absPath) {
      try {
        return await adapter.exists(rel(absPath));
      } catch {
        return false;
      }
    },

    async readBinary(absPath) {
      const buffer = await adapter.readBinary(rel(absPath));
      return new Uint8Array(buffer);
    },

    async writeBinaryAtomic(absPath, bytes) {
      const targetRel = rel(absPath);
      const dirRel = path.posix.dirname(targetRel);
      const tmpRel = `${dirRel === "." ? "" : `${dirRel}/`}.tmp-${Math.random().toString(36).slice(2, 10)}`;
      const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await adapter.writeBinary(tmpRel, exact);
      try {
        await adapter.rename(tmpRel, targetRel);
      } catch {
        // Some adapters refuse rename-over-existing — remove then retry.
        try {
          await adapter.remove(targetRel);
        } catch {
          // destination missing — fine
        }
        await adapter.rename(tmpRel, targetRel);
      }
    },

    async mkdirp(absPath) {
      const parts = rel(absPath).split("/").filter((seg) => seg.length > 0);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        try {
          await adapter.mkdir(acc);
        } catch (e) {
          if (isAlreadyExistsError(e)) continue;
          throw e;
        }
      }
    },

    async rename(fromAbs, toAbs) {
      await adapter.rename(rel(fromAbs), rel(toAbs));
    },

    async listFiles(absDir) {
      try {
        const listed = await adapter.list(rel(absDir));
        return [...listed.files].map(toBareName);
      } catch (e) {
        // A failing list must be loud — a silently-empty result hides the
        // legacy WAL sidecar and breaks the retire flow.
        console.warn(`[db-host] list(${rel(absDir)}) failed: ${errorMessage(e)}`);
        return [];
      }
    },
  };

  // The sql.js wasm is EMBEDDED in the main bundle at build time (base64 —
  // see embedded_wasm.ts): the community store installer fetches only
  // main.js / manifest.json / styles.css, so a disk-based wasm asset can
  // never reach store installs (the 1.3.0 store failure). Embedding also
  // deletes the whole adapter-scan class of bugs — OUT_OF_SCOPE from routing
  // vault-relative configDir/pluginDir through rel(), missing file, stale
  // copy — because there is no disk lookup at all.
  async function loadWasmBinary(): Promise<Uint8Array> {
    return getEmbeddedWasmBinary();
  }

  const onIndexUpgraded = hooks.onIndexUpgraded;
  return {
    io,
    loadWasmBinary,
    createChannel: async (wasmBinary) => new BrowserDbChannel(wasmBinary),
    onIndexUpgraded: onIndexUpgraded ? () => onIndexUpgraded() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Node host (VaultIO fs I/O + in-process worker) — tests and plain Node
// ---------------------------------------------------------------------------

function createNodeDbHost(): DbHost {
  const ioCache = new Map<string, VaultIO>();
  const ioFor = (absDir: string): VaultIO => {
    let io = ioCache.get(absDir);
    if (!io) {
      io = new VaultIO(absDir);
      ioCache.set(absDir, io);
    }
    return io;
  };
  const dirOf = (absPath: string): string => path.dirname(absPath);
  const nameOf = (absPath: string): string => path.basename(absPath);

  // Longest common directory of two absolute paths — the VaultIO root for a
  // cross-directory rename (e.g. dir/index.db → dir/legacy/index.db).
  const commonDir = (a: string, b: string): string => {
    const aParts = a.split(path.sep);
    const bParts = b.split(path.sep);
    const common: string[] = [];
    const n = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < n; i++) {
      if (aParts[i] !== bParts[i]) break;
      common.push(aParts[i]);
    }
    return common.join(path.sep) || path.sep;
  };

  const io: DbFileIO = {
    async exists(absPath) {
      return ioFor(dirOf(absPath)).exists(nameOf(absPath));
    },
    async readBinary(absPath) {
      return ioFor(dirOf(absPath)).readBinary(nameOf(absPath));
    },
    async writeBinaryAtomic(absPath, bytes) {
      ioFor(dirOf(absPath)).writeBinaryAtomic(nameOf(absPath), bytes);
    },
    async mkdirp(absPath) {
      ioFor(absPath).mkdirp(".");
    },
    async rename(fromAbs, toAbs) {
      const root = commonDir(fromAbs, toAbs);
      ioFor(root).rename(path.relative(root, fromAbs), path.relative(root, toAbs));
    },
    async listFiles(absDir) {
      return ioFor(absDir).list(".").files;
    },
  };

  return {
    io,
    // null lets sql.js auto-locate its wasm from node_modules in Node.
    loadWasmBinary: async () => null,
    createChannel: async (wasmBinary) => new InProcessDbChannel(wasmBinary),
  };
}

// ---------------------------------------------------------------------------
// Default host — set once by main.ts onload (Obsidian), Node host otherwise
// ---------------------------------------------------------------------------

let defaultHost: DbHost | null = null;

export function setDefaultDbHost(host: DbHost): void {
  defaultHost = host;
}

export function getDefaultDbHost(): DbHost {
  if (!defaultHost) {
    defaultHost = createNodeDbHost();
  }
  return defaultHost;
}
