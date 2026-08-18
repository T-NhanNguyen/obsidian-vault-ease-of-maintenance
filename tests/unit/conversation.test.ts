// Shared conversation store tests (handoff Part C) — the chat facade's
// behavior is pinned by the untouched chat_session.test.ts; this file covers
// the extraction's new surface: the clarify namespace and the isolation
// between namespaces. Pins: the clarify session lands under
// .note-maintainer/clarify/, history is bounded per namespace, close deletes
// only its own file, and opening a session sweeps only its own dir.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings } from "../../src/config";
import {
  openConversation,
  appendConversationTurn,
  conversationHistory,
  closeConversation,
  CONVERSATION_DIRS,
  CHAT_HISTORY_LIMIT,
} from "../../src/agent/conversation";
import {
  openChatSession,
  appendChatTurn,
  chatHistory,
  closeChatSession,
  CHAT_SESSION_DIR,
} from "../../src/agent/chat_session";

function makeVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nm-conversation-"));
}

function filesIn(vaultDir: string, relDir: string): string[] {
  const dir = path.join(vaultDir, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith("session-"));
}

afterAll(() => {
  closeChatSession();
  closeConversation("clarify");
  updateSettings(defaultSettings());
});

describe("clarify conversation namespace", () => {
  it("persists question/answer turns to the clarify session file and serves history", () => {
    const vault = makeVault();
    appendConversationTurn("clarify", vault, "assistant", "What is the purpose of folder X?");
    appendConversationTurn("clarify", vault, "user", "reference material");

    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);
    const sessionFile = filesIn(vault, CONVERSATION_DIRS.clarify)[0];
    const lines = fs
      .readFileSync(path.join(vault, CONVERSATION_DIRS.clarify, sessionFile), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      role: "assistant",
      content: "What is the purpose of folder X?",
    });
    expect(JSON.parse(lines[1])).toEqual({ role: "user", content: "reference material" });

    expect(conversationHistory("clarify")).toEqual([
      { role: "assistant", content: "What is the purpose of folder X?" },
      { role: "user", content: "reference material" },
    ]);
    closeConversation("clarify");
  });

  it("bounds clarify history to CHAT_HISTORY_LIMIT independently", () => {
    const vault = makeVault();
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 4; i++) {
      appendConversationTurn("clarify", vault, "assistant", `q${i}`);
      appendConversationTurn("clarify", vault, "user", `a${i}`);
    }
    const history = conversationHistory("clarify");
    expect(history).toHaveLength(CHAT_HISTORY_LIMIT);
    // 38 turns pushed, 23 dropped: first survivor is a11 (position 23), last is a18.
    expect(history[0]).toEqual({ role: "user", content: "a11" });
    expect(history[history.length - 1]).toEqual({ role: "user", content: "a18" });
    closeConversation("clarify");
  });

  it("chat and clarify sessions are fully isolated (dirs, files, history)", () => {
    const vault = makeVault();
    appendChatTurn(vault, "user", "chat question");
    appendConversationTurn("clarify", vault, "assistant", "clarify question");

    expect(filesIn(vault, CHAT_SESSION_DIR)).toHaveLength(1);
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);
    expect(chatHistory()).toEqual([{ role: "user", content: "chat question" }]);
    expect(conversationHistory("clarify")).toEqual([
      { role: "assistant", content: "clarify question" },
    ]);

    closeChatSession();
    closeConversation("clarify");
  });

  it("closing the clarify session deletes only its own file", () => {
    const vault = makeVault();
    appendChatTurn(vault, "user", "q");
    appendConversationTurn("clarify", vault, "assistant", "q");
    expect(filesIn(vault, CHAT_SESSION_DIR)).toHaveLength(1);
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);

    closeConversation("clarify");
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(0);
    expect(filesIn(vault, CHAT_SESSION_DIR)).toHaveLength(1);

    closeChatSession();
  });

  it("openConversation sweeps clarify orphans without touching the chat dir", () => {
    const vault = makeVault();
    const clarifyDir = path.join(vault, CONVERSATION_DIRS.clarify);
    const chatDir = path.join(vault, CHAT_SESSION_DIR);
    fs.mkdirSync(clarifyDir, { recursive: true });
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(clarifyDir, "session-1111111111-dead.jsonl"), "{}");
    fs.writeFileSync(path.join(chatDir, "session-1111111112-keep.jsonl"), "{}");

    openConversation("clarify", vault);
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);
    // The chat orphan stays — each namespace sweeps only its own dir.
    expect(filesIn(vault, CHAT_SESSION_DIR)).toHaveLength(1);
    closeConversation("clarify");
  });

  it("chat facade delegation stays intact alongside the clarify namespace", () => {
    const vault = makeVault();
    openChatSession(vault);
    appendChatTurn(vault, "user", "hello");
    expect(chatHistory()).toEqual([{ role: "user", content: "hello" }]);
    // The chat facade is namespace "chat": the clarify history is untouched.
    expect(conversationHistory("clarify")).toEqual([]);
    closeChatSession();
  });
});
