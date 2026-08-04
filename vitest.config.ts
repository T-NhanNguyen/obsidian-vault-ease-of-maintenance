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
    },
  },
});
