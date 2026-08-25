// Chat router — the single intent-aware router for every chat-surface
// submission (plain chat, the understand-vault command, and the cold build's
// stage). One query function for all three intents fixes the build-pane
// follow-up hijack: after the stage completes, follow-ups route to regular
// RAG chat instead of re-running the pipeline. The router also owns the
// semaphore: every run acquires the chat lock and releases it in a finally,
// so a concurrent submission (another chat intent, or the headless warm
// build) gets the busy answer immediately — zero LLM calls — instead of
// starting a second run that would share module-level registries and the
// sql.js DB. Internal tool calls (comprehend_vault's cold path) never
// acquire: they run inside the already-held lock (no re-entrancy, no
// deadlock).

import { settings } from "./config";
import {
  acquireChatLock,
  releaseChatLock,
  chatLockHolder,
  type ChatLockOwner,
} from "./chat_gate";
import {
  runChatQuery,
  runComprehension,
  isComprehensionRequest,
  runComprehensionBuildStage,
  runBuildIndex,
} from "./agent/runtime";
import type { ChatQueryResponse } from "./types";
import type { ClarifyAnswerProvider } from "./agent/tools";

export type { ChatIntent } from "./types";

const BUSY_ANSWER_PREFIX = "Vault maintenance is busy";
const BUSY_ANSWER_SUFFIX = "Wait for it to finish, then ask again.";

/** The busy message with the current lock holder, shared by the router's
 * busy answer and the warm-build command's Notice (single source of
 * truth for the rejection wording). */
export function chatBusyMessage(): string {
  const holder = chatLockHolder() ?? "another run";
  return `[${BUSY_ANSWER_PREFIX} — ${holder} in progress. ${BUSY_ANSWER_SUFFIX}]`;
}

/** The immediate rejection a submission gets while the chat lock is held:
 * a clear busy message, no sources, no citations, zero work done. */
function busyAnswer(): ChatQueryResponse {
  return { answer: chatBusyMessage(), results: [], citationMap: {} };
}

/** Runs one chat-surface query under the chat lock.
 *
 * - runBuildStage (the cold build's first question): comprehension stage →
 *   manifest population → index build, all in one answer.
 * - isComprehensionRequest (the explicit understand-vault command): the
 *   comprehension pipeline (run-once card reuse unchanged).
 * - Everything else: regular RAG chat — including every follow-up after a
 *   build completes.
 */
export async function runChatRouter(
  question: string,
  ask?: ClarifyAnswerProvider,
  runBuildStage = false,
): Promise<ChatQueryResponse> {
  const owner: ChatLockOwner = runBuildStage ? "build" : "chat";
  if (!acquireChatLock(owner)) return busyAnswer();
  try {
    if (runBuildStage) {
      const comprehension = await runComprehensionBuildStage(settings.vaultPath, question, ask);
      const build = await runBuildIndex(settings.vaultPath);
      return { ...comprehension, answer: `${comprehension.answer}\n\n${build}` };
    }
    if (isComprehensionRequest(question)) return await runComprehension(question, ask);
    return await runChatQuery(question, ask);
  } finally {
    releaseChatLock();
  }
}
