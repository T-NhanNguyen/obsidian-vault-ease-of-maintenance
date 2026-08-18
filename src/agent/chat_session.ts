// Chat session store facade — the chat-tab namespace of the shared
// conversation store (src/agent/conversation.ts, handoff Part C). Kept as a
// separate module so the chat call sites (runtime_chat, review-core, main)
// and the pinned chat tests keep their import paths; behavior is delegated
// to the shared store and stays byte-identical.

import {
  openConversation,
  appendConversationTurn,
  conversationHistory,
  closeConversation,
  CONVERSATION_DIRS,
  CHAT_HISTORY_LIMIT,
} from "./conversation";
import type { ChatMessage } from "./llm_client";

export const CHAT_SESSION_DIR = CONVERSATION_DIRS.chat;
export { CHAT_HISTORY_LIMIT };

export function openChatSession(vaultPath: string): void {
  openConversation("chat", vaultPath);
}

export function appendChatTurn(
  vaultPath: string,
  role: "user" | "assistant",
  content: string,
): void {
  appendConversationTurn("chat", vaultPath, role, content);
}

/** Prior turns as chat-loop messages (bounded to CHAT_HISTORY_LIMIT). */
export function chatHistory(): ChatMessage[] {
  return conversationHistory("chat");
}

export function closeChatSession(): void {
  closeConversation("chat");
}

export function closeClarifySession(): void {
  closeConversation("clarify");
}

export function appendClarifyTurn(
  vaultPath: string,
  role: "user" | "assistant",
  content: string,
): void {
  appendConversationTurn("clarify", vaultPath, role, content);
}
