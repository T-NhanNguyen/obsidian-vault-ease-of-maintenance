// Agent Runtime — public facade over the four orchestrator modules.
//
// Cleanup, sort, chat, and build each live in their own module so adjusting
// one concern never requires editing the others:
//   - runtime_cleanup.ts — clean-current-note agent flow (ProposedChange)
//   - runtime_sort.ts    — inbox triage agent flow (SortResult/SortDecision)
//   - runtime_chat.ts    — capability-gated chat query flow
//   - runtime_build.ts   — index build + manifest derivation
//
// This file only re-exports the orchestrators (importers such as main.ts and
// the review pages keep their import paths) and the prompts.

export { runCleanup } from "./runtime_cleanup";
export type { ProposedChange } from "./runtime_cleanup";

export { runTriage } from "./runtime_sort";
export { SortResult } from "./runtime_sort";
export type { SortDecision } from "./runtime_sort";

export { runChat, runChatQuery, CHAT_SYSTEM_PROMPT, CHAT_GROUNDED_SYSTEM_PROMPT } from "./runtime_chat";

export { runComprehension } from "../comprehension/runtime_comprehension";

export { runBuild, generateManifest } from "./runtime_build";
