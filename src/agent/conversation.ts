// Shared conversation store — the plugin-side "pseudo-stateful" memory for
// the chat tab AND the clarify dialog (handoff Part C). The LLM API stays
// stateless; this module keeps the ACTIVE session's turns on disk per
// namespace so each call can re-inject them as prior conversation.
//
// Namespaces: `chat` (the chat tab) and `clarify` (the clarification dialog).
// Each namespace has its own session directory under .note-maintainer/, its
// own active session, and its own sweep — two conversations never cross.
//
// STORAGE CONTRACT: only plain user/assistant turns are ever stored.
// Retrieval context (notes blocks), tool calls, candidate scores, and tool
// results are per-request plumbing — they are piped into the call and never
// appended, keeping history bounded to CHAT_HISTORY_LIMIT messages.
//
// Lifecycle: opened lazily on the first turn, deleted when the tab closes or
// the plugin unloads. Stale files (crash orphans) are swept when a new
// session opens. Files live under {vault}/.note-maintainer/<namespace>/ —
// inside the documented generated-data space, so one VCS ignore rule covers
// them. Unique per-session names (timestamp + random) prevent two users of a
// shared vault from overwriting each other's session.

import * as crypto from "crypto";
import { VaultIO } from "../io/vault_io";
import type { ChatMessage } from "./llm_client";

export type ConversationNamespace = "chat" | "clarify";

export const CHAT_HISTORY_LIMIT = 15;
const SESSION_FILE_PREFIX = "session-";
const SESSION_FILE_SUFFIX = ".jsonl";

export const CONVERSATION_DIRS: Record<ConversationNamespace, string> = {
  chat: ".note-maintainer/chat",
  clarify: ".note-maintainer/clarify",
};

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface ActiveConversation {
  namespace: ConversationNamespace;
  vaultPath: string;
  relPath: string;
  turns: ConversationTurn[];
}

const activeSessions = new Map<ConversationNamespace, ActiveConversation>();

export function openConversation(namespace: ConversationNamespace, vaultPath: string): void {
  if (!vaultPath) return;
  const active = activeSessions.get(namespace);
  if (active && active.vaultPath === vaultPath) return;
  closeConversation(namespace);

  const io = new VaultIO(vaultPath);
  const dir = CONVERSATION_DIRS[namespace];
  sweepOrphans(io, dir);
  const name = `${SESSION_FILE_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString("hex")}${SESSION_FILE_SUFFIX}`;
  const relPath = `${dir}/${name}`;
  io.writeTextAtomic(relPath, "");
  activeSessions.set(namespace, { namespace, vaultPath, relPath, turns: [] });
}

export function appendConversationTurn(
  namespace: ConversationNamespace,
  vaultPath: string,
  role: "user" | "assistant",
  content: string,
): void {
  if (!vaultPath || !content) return;
  let active = activeSessions.get(namespace);
  if (!active || active.vaultPath !== vaultPath) {
    openConversation(namespace, vaultPath);
    active = activeSessions.get(namespace);
  }
  if (!active) return;

  const turn: ConversationTurn = { role, content };
  active.turns.push(turn);
  if (active.turns.length > CHAT_HISTORY_LIMIT) active.turns.shift();
  new VaultIO(vaultPath).appendText(active.relPath, JSON.stringify(turn) + "\n");
}

/** Prior turns as chat-loop messages (bounded to CHAT_HISTORY_LIMIT). */
export function conversationHistory(namespace: ConversationNamespace): ChatMessage[] {
  const active = activeSessions.get(namespace);
  if (!active) return [];
  return active.turns.map(t => ({ role: t.role, content: t.content }));
}

export function closeConversation(namespace: ConversationNamespace): void {
  const active = activeSessions.get(namespace);
  if (!active) return;
  try {
    new VaultIO(active.vaultPath).remove(active.relPath);
  } catch { /* best-effort — an orphan is swept later */ }
  activeSessions.delete(namespace);
}

function sweepOrphans(io: VaultIO, dir: string): void {
  const { files } = io.list(dir);
  for (const name of files) {
    if (name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX)) {
      io.remove(`${dir}/${name}`);
    }
  }
}
