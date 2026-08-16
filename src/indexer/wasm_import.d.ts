// Ambient declaration for the build-time embedded wasm: esbuild's `.wasm`
// binary loader (esbuild.config.mjs) turns the import below into a base64
// string inside main.js. The explicit specifier (not a `*.wasm` wildcard) is
// needed because TypeScript resolves the bare subpath through
// node_modules/sql.js first and never consults a wildcard declaration.
// Tests alias the import to a stub fixture (tests/fixtures/wasm_stub.ts) —
// see vitest.config.ts.
// NOTE: this file is NOT named embedded_wasm.d.ts — a declaration file that
// shares its basename with the .ts module is treated as its companion
// declaration and its ambient module is never consulted.
declare module "sql.js/dist/sql-wasm.wasm" {
  const base64: string;
  export default base64;
}
