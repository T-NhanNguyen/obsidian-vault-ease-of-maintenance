import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    setupFiles: [],
    globals: false,
  },
  resolve: {
    alias: {
      "@src": "/src",
      // The obsidian npm package ships types only (empty "main"), so Vite
      // cannot resolve it. Alias to a stub for tests; the plugin build keeps
      // "obsidian" as an esbuild external (real module at runtime).
      "obsidian": "/tests/fixtures/obsidian_stub.ts",
    },
  },
});
