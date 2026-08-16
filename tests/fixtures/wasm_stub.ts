// Test stand-in for the build-time embedded wasm. esbuild's `.wasm` binary
// loader (esbuild.config.mjs) turns `import … from "sql.js/dist/sql-wasm.wasm"`
// into a base64 string inside main.js; vitest aliases that bare specifier
// here so tests never load the real 658 KB sql.js wasm. The stub is the
// base64 of an 8-byte minimal wasm module header (\0asm\x01\x00\x00\x00),
// so embedded_wasm decode paths run with deterministic content. Mirrors the
// @worker-bundle / obsidian stub convention in this folder.
const MINIMAL_WASM_HEADER_BASE64 = "AGFzbQEAAAA=";

export default MINIMAL_WASM_HEADER_BASE64;
