import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// esbuild bundles .md files as raw text (loader: { ".md": "text" }, see
// esbuild.config.mjs) — vitest must do the same or test imports of
// maintainer-definitions/*.md (and runtime_cleanup.ts's skill import) fail
// with "Failed to parse source ... invalid JS syntax".
const markdownTextPlugin = (): Plugin => ({
  name: "markdown-text",
  enforce: "pre",
  transform(code, id) {
    if (id.endsWith(".md")) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
    return undefined;
  },
});

export default defineConfig({
  plugins: [markdownTextPlugin()],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    setupFiles: [],
    globals: false,
  },
  resolve: {
    alias: {
      "@src": "/src",
      // Build-time virtual module (worker bundle string); see
      // tests/fixtures/worker_bundle_stub.ts.
      "@worker-bundle": "/tests/fixtures/worker_bundle_stub.ts",
      // Build-time embedded wasm (esbuild embeddedWasmPlugin inlines the
      // sql.js wasm as a base64 string); see tests/fixtures/wasm_stub.ts
      // and src/indexer/embedded_wasm.ts.
      "sql.js/dist/sql-wasm.wasm": "/tests/fixtures/wasm_stub.ts",
      // The obsidian npm package ships types only (empty "main"), so Vite
      // cannot resolve it. Alias to a stub for tests; the plugin build keeps
      // "obsidian" as an esbuild external (real module at runtime).
      "obsidian": "/tests/fixtures/obsidian_stub.ts",
    },
  },
});
