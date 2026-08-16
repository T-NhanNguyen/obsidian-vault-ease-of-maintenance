// The sql.js WASM engine, embedded into the main bundle at build time.
//
// esbuild's `.wasm` binary loader (esbuild.config.mjs) turns the import below
// into a base64 string literal inside main.js. The Obsidian community store
// installer fetches exactly three assets — main.js, manifest.json,
// styles.css — so a disk-based wasm asset can NEVER reach store installs
// (that was the 1.3.0 store failure: "sql.js wasm asset not found"). Embedding
// makes the plugin fully self-sufficient and offline-first: no download, no
// plugin-dir scan, no cache.
//
// zkdavis's obsidian-smart-vault ships wasm exactly this way (esbuild
// loader + embedded import; their initSync point is already satisfied here —
// the worker calls initSqlJs({ wasmBinary }) with explicit bytes, never a URL).
//
// The worker bundle (db_worker/) does NOT import this module — the decoded
// bytes cross to the disposable worker via postMessage (see db_host.ts), and
// embedding them again in the worker string would double-encode.

import sqlWasmBase64 from "sql.js/dist/sql-wasm.wasm";

let cachedBytes: Uint8Array | null = null;

/**
 * The sql.js wasm bytes, decoded once and cached. Immutable at runtime, so
 * sharing one instance across executions is safe (BrowserDbChannel
 * structured-clones it per worker open; the DB bytes transfer separately).
 */
export function getEmbeddedWasmBinary(): Uint8Array {
  if (!cachedBytes) {
    const binary = atob(sqlWasmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    cachedBytes = bytes;
  }
  return cachedBytes;
}
