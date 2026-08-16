// Web Worker entry — bundled by esbuild (second pass, IIFE) and embedded in
// main.js as a string, then spawned by the browser channel via
// `new Worker(URL.createObjectURL(new Blob([WORKER_BUNDLE])))`.
//
// Message contract (see protocol.ts):
//   { kind: "open",  wasmBinary, dbBytes } → { kind: "open-result", needsRebuild }
//   { kind: "op",    id, method, args }    → { kind: "op-result", id, ok, value|error }
//   { kind: "close" }                      → { kind: "close-result", ok, bytes|error }
//
// The worker is disposable: one per GraphRAG execution, terminated when the
// execution finishes. Worker death frees sql.js's WASM heap, which never
// shrinks in-process (the measured ~10× build balloon is contained by this
// lifecycle — see .dev-vault/tips/sqlite-wasm-worker-design.md).

import type { WorkerRequest, WorkerResponse } from "./protocol";
import { DbWorkerCore } from "./worker_core";

let core: DbWorkerCore | null = null;

async function handle(message: WorkerRequest): Promise<WorkerResponse> {
  switch (message.kind) {
    case "open": {
      core = new DbWorkerCore(message.wasmBinary);
      const result = await core.open(message.dbBytes);
      return { kind: "open-result", needsRebuild: result.needsRebuild };
    }
    case "op": {
      if (!core) {
        return { kind: "op-result", id: message.id, ok: false, error: "worker not open" };
      }
      try {
        const value = core.call(message.method, message.args);
        return { kind: "op-result", id: message.id, ok: true, value };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return { kind: "op-result", id: message.id, ok: false, error: err.message };
      }
    }
    case "close": {
      if (!core) {
        return { kind: "close-result", ok: true, bytes: null };
      }
      try {
        const bytes = core.close();
        return { kind: "close-result", ok: true, bytes };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return { kind: "close-result", ok: false, error: err.message };
      }
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  void handle(event.data).then((response) => {
    const transfer: Transferable[] = [];
    if (response.kind === "close-result" && response.bytes) {
      transfer.push(response.bytes.buffer as Transferable);
    }
    (self as unknown as Worker).postMessage(response, transfer);
  });
};
