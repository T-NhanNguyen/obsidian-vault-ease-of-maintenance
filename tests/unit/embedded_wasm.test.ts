// Unit tests for the build-time embedded sql.js wasm (zkdavis
// obsidian-smart-vault pattern, handoff 2026-08-16). The wasm is embedded
// in the main bundle as base64 (esbuild embeddedWasmPlugin) so store
// installs — which ship only main.js / manifest.json / styles.css — are
// fully self-sufficient. Vitest aliases the wasm import to a minimal valid
// wasm header (tests/fixtures/wasm_stub.ts), so these tests pin the decode
// contract with deterministic content.

import { describe, it, expect } from "vitest";
import { getEmbeddedWasmBinary } from "../../src/indexer/embedded_wasm";

describe("embedded sql.js wasm (store-safe base64 embed)", () => {
  it("decodes the embedded base64 to a valid wasm module (\\0asm magic + version 1)", () => {
    const bytes = getEmbeddedWasmBinary();
    expect([...bytes.subarray(0, 5)]).toEqual([0, 0x61, 0x73, 0x6d, 1]);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("decodes once and shares the cached instance across callers", () => {
    expect(getEmbeddedWasmBinary()).toBe(getEmbeddedWasmBinary());
  });
});
