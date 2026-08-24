// Comprehend-vault tool — the agent's window into the vault's one-page
// summary card (handoff Part B). Read-only on the cached path: returns the
// card text when a valid card exists, with no LLM call and no pipeline run.
// On the cold path (no valid card) it runs the comprehension pipeline once
// and returns the fresh synthesis. Mirrors the run-once reuse rule from
// runtime_comprehension.ts (isReusableCard, the single source of truth).
//
// Lives in its own module (like tools_apply_edits.ts) so tools.ts never
// imports runtime_comprehension.ts — that module imports withClarify from
// tools.ts, and a direct import here would close an import cycle.

import { settings } from "../config";
import { Tool } from "./llm";
import { SummaryCardStore, isReusableCard } from "../comprehension/summary";
import {
  runComprehension,
  DEFAULT_COMPREHENSION_QUESTION,
} from "../comprehension/runtime_comprehension";

export const COMPREHEND_VAULT_TOOL = {
  name: "comprehend_vault",
  description:
    "Read the vault's one-page summary: what the vault is about, its folder " +
    "structure, and its leading assumptions. Call for overview questions " +
    "('what is this vault about?') or before a task that needs the vault " +
    "shape. Returns the cached summary card when one exists; otherwise runs " +
    "a fresh comprehension pass (slow) and returns its synthesis.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export async function comprehendVault(): Promise<string> {
  const summaryStore = new SummaryCardStore(settings.vaultPath);
  const existing = summaryStore.readStructured();
  if (isReusableCard(existing)) {
    return summaryStore.read() ?? existing.synthesis;
  }
  // Cold path: no valid card — run the pipeline once. No answer provider
  // here (build/sort/cleanup loops have none); mandatory clarifications
  // surface the NO_ANSWER marker and the run ends flagged — the card is
  // still written and returned (recorded decision D3).
  const response = await runComprehension(DEFAULT_COMPREHENSION_QUESTION);
  return response.answer;
}

export function buildComprehendVaultTool(): Tool {
  return new Tool(
    COMPREHEND_VAULT_TOOL.name,
    COMPREHEND_VAULT_TOOL.description,
    COMPREHEND_VAULT_TOOL.parameters,
    () => comprehendVault(),
  );
}
