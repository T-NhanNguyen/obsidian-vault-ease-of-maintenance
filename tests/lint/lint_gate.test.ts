// Store-review lint gate — turns the Obsidian plugin-review bot's automated
// checks into part of our own test suite. Runs the same eslint-plugin-obsidianmd
// config the bot uses (see eslint.config.mjs), then applies the bot's report
// classification so a green gate predicts a non-regressing store review.
//
// Bot classification (verified empirically against store-review reports, see
// .dev-vault/dev/2026-08-11-lint-warning-analysis.md): the bot demotes every
// @typescript-eslint/* rule and obsidianmd/rule-custom-message (no-console) to
// warnings; everything else keeps config severity — obsidianmd/* errors and
// eslint-comments/* errors are what actually block a review.
//
// Budget policy: 0 blocking errors is a hard requirement. The warning budget is
// a ceiling that shrinks as the `any` debt is paid down — lower it whenever a
// fix removes warnings, never raise it without a written justification in the
// dev-vault.

import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const WARNING_BUDGET = 362;
const LINT_TARGETS = ["main.ts", "src/**/*.ts"];

function isBotDemoted(ruleId: string | null | undefined): boolean {
  if (!ruleId) return false;
  return ruleId.startsWith("@typescript-eslint/") || ruleId === "obsidianmd/rule-custom-message";
}

describe("store-review lint gate", () => {
  it("reports zero blocking errors and stays within the warning budget", async () => {
    const eslint = new ESLint();
    const results = await eslint.lintFiles(LINT_TARGETS);
    const formatter = await eslint.loadFormatter("stylish");
    const report = await formatter.format(results);

    const messages = results.flatMap((result) => result.messages);
    const blockingErrors = messages.filter((m) => m.severity === 2 && !isBotDemoted(m.ruleId));
    const botWarnings = messages.filter((m) => m.severity === 1 || isBotDemoted(m.ruleId));

    expect(
      blockingErrors.map((m) => `${m.ruleId} at ${m.line}`),
      report
    ).toEqual([]);
    expect(botWarnings.length, report).toBeLessThanOrEqual(WARNING_BUDGET);
  });
});
