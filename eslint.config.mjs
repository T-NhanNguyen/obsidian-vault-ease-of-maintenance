// Local reproduction of the Obsidian store-review lint (eslint-plugin-obsidianmd
// 0.4.1 — the version the plugin-review bot runs on obsidianmd/obsidian-releases).
// Mirrors the recipe in .dev-vault/dev/2026-08-11-store-review-blockers.md so a
// local run predicts the bot's report. The lint gate in tests/lint/lint_gate.test.ts
// enforces 0 errors and a warning budget on top of this config.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidian from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "main.js",
    "tests/**",
    ".dev-vault/**",
    "**/*.d.ts",
    "maintainer-definitions/**",
  ]),
  obsidian.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Hard ceiling: no source file may exceed 1000 physical lines (handoff
    // 2026-08-15 isolation refactor). Keep every file under the cap — the
    // lint gate in tests/lint/lint_gate.test.ts enforces a 0-warning budget.
    rules: {
      "max-lines": ["warn", { max: 1000 }],
    },
  },
]);
