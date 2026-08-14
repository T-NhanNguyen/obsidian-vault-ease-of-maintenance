// Chat session store — the plugin-side "pseudo-stateful" memory for the chat
// tab. The LLM API stays stateless; this module keeps the ACTIVE session's
// turns on disk so each runChatQuery call can re-inject them as prior
// conversation. Chat-specific only: clean/sort/build never touch it.
//
// Lifecycle: opened lazily on the first chat turn, deleted when the chat tab
// closes or the plugin unloads. Stale files (crash orphans) are swept when a
// new session opens. Files live under {vault}/.note-maintainer/chat/ — inside
// the documented generated-data space, so one VCS ignore rule covers them.
// Unique per-session names (timestamp + random) prevent two users of a shared
// vault from overwriting each other's session.
//
// The history is INVISIBLE to the chat UI: the tab renders its own message
// list and never reads these files back. The store is write + read-for-prompt
// only.

import * as crypto from "crypto";
import { VaultIO } from "../io/vault_io";
import type { ChatMessage } from "./llm_client";

export const CHAT_SESSION_DIR = ".note-maintainer/chat";
export const CHAT_HISTORY_LIMIT = 15;
const SESSION_FILE_PREFIX = "session-";
const SESSION_FILE_SUFFIX = ".jsonl";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface ActiveSession {
  vaultPath: string;
  relPath: string;
  turns: ChatTurn[];
}

let active: ActiveSession | null = null;

export function openChatSession(vaultPath: string): void {
  if (!vaultPath) return;
  if (active && active.vaultPath === vaultPath) return;
  closeChatSession();

  const io = new VaultIO(vaultPath);
  sweepOrphans(io);
  const name = `${SESSION_FILE_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString("hex")}${SESSION_FILE_SUFFIX}`;
  const relPath = `${CHAT_SESSION_DIR}/${name}`;
  io.writeTextAtomic(relPath, "");
  active = { vaultPath, relPath, turns: [] };
}

export function appendChatTurn(
  vaultPath: string,
  role: "user" | "assistant",
  content: string,
): void {
  if (!vaultPath || !content) return;
  if (!active || active.vaultPath !== vaultPath) openChatSession(vaultPath);
  if (!active) return;

  const turn: ChatTurn = { role, content };
  active.turns.push(turn);
  if (active.turns.length > CHAT_HISTORY_LIMIT) active.turns.shift();
  new VaultIO(vaultPath).appendText(active.relPath, JSON.stringify(turn) + "\n");
}

/** Prior turns as chat-loop messages (bounded to CHAT_HISTORY_LIMIT). */
export function chatHistory(): ChatMessage[] {
  if (!active) return [];
  return active.turns.map(t => ({ role: t.role, content: t.content }));
}

export function closeChatSession(): void {
  if (!active) return;
  try {
    new VaultIO(active.vaultPath).remove(active.relPath);
  } catch { /* best-effort — an orphan is swept later */ }
  active = null;
}

function sweepOrphans(io: VaultIO): void {
  const { files } = io.list(CHAT_SESSION_DIR);
  for (const name of files) {
    if (name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX)) {
      io.remove(`${CHAT_SESSION_DIR}/${name}`);
    }
  }
}
